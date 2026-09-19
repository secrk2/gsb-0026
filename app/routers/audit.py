"""变更留痕 API：配置改动流水查询 + 差异清单 CSV 导出。

- 支持按应用、环境、动作、时间窗筛选；管理员可按业务线筛选，成员强制收窄到本业务线；
- 留痕表只追加，密文值在写入时已脱敏，导出也不会泄露明文；
- CSV 加 UTF-8 BOM，Excel 直接打开不乱码；对公式注入字符做转义。
"""
import csv
import io
from datetime import datetime, time as dtime

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from ..auth import User, check_bl_scope, err, is_admin
from ..db import (
    AUDIT_CONFIG_ROLLBACK, AUDIT_CONFIG_UPDATE, AUDIT_SECRET_VIEW,
    ENV_LABELS, query, query_one,
)
from ..routers.common import check_env

router = APIRouter(prefix="/api/audit", tags=["audit"])

ACTIONS = [AUDIT_CONFIG_UPDATE, AUDIT_CONFIG_ROLLBACK, AUDIT_SECRET_VIEW]
MAX_LIMIT = 1000


def _parse_date(value: str | None, end_of_day: bool = False) -> int | None:
    if not value:
        return None
    try:
        d = datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        raise err(400, f"日期格式应为 YYYY-MM-DD：{value}")
    return int(datetime.combine(d, dtime.max if end_of_day else dtime.min).timestamp())


def _scope_where(user: dict, business_line_id: int | None, app_id: int | None) -> tuple[str, list]:
    """拼权限收窄条件；显式指定其他业务线/其他业务线应用按越权 403 处理。"""
    where, params = "", []
    if is_admin(user):
        if business_line_id:
            if not query_one("SELECT id FROM business_lines WHERE id = ?", (business_line_id,)):
                raise err(404, f"业务线 #{business_line_id} 不存在")
            where += " AND a.business_line_id = ?"
            params.append(business_line_id)
    else:
        if business_line_id and business_line_id != user["business_line_id"]:
            check_bl_scope(user, business_line_id)
        where += " AND a.business_line_id = ?"
        params.append(user["business_line_id"])
    if app_id:
        app = query_one("SELECT id, business_line_id FROM applications WHERE id = ?", (app_id,))
        if not app:
            raise err(404, f"应用 #{app_id} 不存在")
        check_bl_scope(user, app["business_line_id"])
        where += " AND l.app_id = ?"
        params.append(app_id)
    return where, params


def _build_query(user, business_line_id, app_id, environment, action, start_ts, end_ts) -> tuple[str, list]:
    where, params = _scope_where(user, business_line_id, app_id)
    if environment:
        where += " AND l.environment = ?"
        params.append(environment)
    if action:
        where += " AND l.action = ?"
        params.append(action)
    if start_ts is not None:
        where += " AND l.created_at >= ?"
        params.append(start_ts)
    if end_ts is not None:
        where += " AND l.created_at <= ?"
        params.append(end_ts)
    sql = f"""
        SELECT l.id, l.app_id, a.name AS app_name, b.name AS business_line_name,
               l.environment, l.action, l.config_key, l.old_value, l.new_value,
               l.value_type, l.scope, l.is_secret, l.reason, l.created_at,
               u.name AS user_name, u.username,
               v.version AS config_version
        FROM config_audit_logs l
        JOIN applications a ON a.id = l.app_id
        JOIN business_lines b ON b.id = a.business_line_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN config_versions v ON v.id = l.version_id
        WHERE 1=1 {where}
        ORDER BY l.created_at DESC, l.id DESC
    """
    return sql, params


def _row_dict(r) -> dict:
    d = dict(r)
    d["environment_label"] = ENV_LABELS.get(r["environment"], r["environment"])
    d["is_secret"] = bool(r["is_secret"])
    return d


@router.get("/configs")
def list_audit(
    user: dict = User,
    business_line_id: int | None = None,
    app_id: int | None = None,
    environment: str | None = None,
    action: str | None = None,
    start: str | None = None,
    end: str | None = None,
    limit: int = Query(default=200, ge=1, le=MAX_LIMIT),
):
    if environment:
        check_env(environment)
    if action and action not in ACTIONS:
        raise err(400, f"非法动作：{action}，可选：{'/'.join(ACTIONS)}")
    start_ts, end_ts = _parse_date(start), _parse_date(end, end_of_day=True)
    if start_ts and end_ts and start_ts > end_ts:
        raise err(400, "开始日期不能晚于结束日期")
    sql, params = _build_query(user, business_line_id, app_id, environment, action, start_ts, end_ts)
    rows = query(sql + " LIMIT ?", (*params, limit))
    return {
        "actions": ACTIONS,
        "total": len(rows),
        "items": [_row_dict(r) for r in rows],
    }


def _csv_cell(value) -> str:
    s = "" if value is None else str(value)
    # 防 CSV 公式注入：= + - @ 及制表/回车开头的单元格加单引号前缀
    if s[:1] in ("=", "+", "-", "@", "\t", "\r"):
        s = "'" + s
    return s


@router.get("/configs/export.csv")
def export_audit(
    user: dict = User,
    business_line_id: int | None = None,
    app_id: int | None = None,
    environment: str | None = None,
    action: str | None = None,
    start: str | None = None,
    end: str | None = None,
):
    if environment:
        check_env(environment)
    if action and action not in ACTIONS:
        raise err(400, f"非法动作：{action}")
    start_ts, end_ts = _parse_date(start), _parse_date(end, end_of_day=True)
    sql, params = _build_query(user, business_line_id, app_id, environment, action, start_ts, end_ts)
    rows = query(sql, tuple(params))

    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM，Excel 打开不乱码
    writer = csv.writer(buf)
    writer.writerow(["时间", "业务线", "应用", "环境", "版本", "操作人", "动作",
                     "配置键", "改前值", "改后值", "值类型", "生效范围", "密文", "查看/变更理由"])
    for r in reversed(rows):  # 按时间正序导出更接近"差异清单"的阅读习惯
        writer.writerow([
            datetime.fromtimestamp(r["created_at"]).strftime("%Y-%m-%d %H:%M:%S"),
            _csv_cell(r["business_line_name"]),
            _csv_cell(r["app_name"]),
            ENV_LABELS.get(r["environment"], r["environment"]),
            f"v{r['config_version']}" if r["config_version"] else "",
            _csv_cell(r["user_name"] or "系统"),
            r["action"],
            _csv_cell(r["config_key"]),
            _csv_cell(r["old_value"]),
            _csv_cell(r["new_value"]),
            r["value_type"],
            r["scope"],
            "是" if r["is_secret"] else "否",
            _csv_cell(r["reason"]),
        ])
    buf.seek(0)
    fname = f"config-audit-{start or 'all'}-{end or 'all'}.csv"
    return StreamingResponse(
        iter([buf.getvalue().encode("utf-8")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
