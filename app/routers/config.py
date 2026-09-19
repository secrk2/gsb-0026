"""配置档案 API：按 应用 + 环境 管理配置项。

要点：
- 密文配置项加密落盘（enc:v1: 前缀），列表/对比/版本接口一律脱敏（******）；
- 明文查看必须服务端强制填写理由（非空校验在后端），并写入只追加的留痕；
- 每次保存 / 回滚都产生一个只增的新版本，逐键写留痕；
- 回滚 = 以旧版本快照追加一个新版本，历史版本与历史留痕都不会被覆盖。
"""
import json
import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import crypto
from ..auth import User, err
from ..db import (
    AUDIT_CONFIG_ROLLBACK, AUDIT_CONFIG_UPDATE, AUDIT_SECRET_VIEW,
    CONFIG_SCOPES, CONFIG_TYPES, ENVIRONMENTS, ENV_LABELS,
    TERMINAL_STATUS, execute, get_conn, query, query_one,
)
from .common import check_env, get_app_checked

router = APIRouter(prefix="/api/apps/{app_id}", tags=["config"])

MASK = "******"


# ---------------------------------------------------------------- 请求模型

class ConfigItemIn(BaseModel):
    key: str = Field(min_length=1, max_length=128)
    value: str = ""
    value_type: str = "string"
    scope: str = "global"
    is_secret: bool = False
    secret_kept: bool = False   # 密文未改动（列表里是脱敏值），服务端以原密文回填


class ConfigSaveIn(BaseModel):
    items: list[ConfigItemIn]
    comment: str = Field(default="", max_length=200)


class RevealIn(BaseModel):
    key: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=200)


class RollbackIn(BaseModel):
    version: int
    comment: str = Field(default="", max_length=200)


# ---------------------------------------------------------------- 工具函数

def _validate_value(value_type: str, value: str) -> str:
    """按类型校验值，返回规范化后的字符串形式。"""
    if value_type == "number":
        try:
            float(value.strip())
        except ValueError:
            raise ValueError(f"值「{value}」不是合法数值")
        return value.strip()
    if value_type == "boolean":
        low = value.strip().lower()
        if low not in ("true", "false"):
            raise ValueError(f"布尔值只能是 true 或 false，收到：{value}")
        return low
    if value_type == "json":
        try:
            json.loads(value)
        except Exception:
            raise ValueError("JSON 类型的值不是合法 JSON")
    return value


def _current_rows(app_id: int, environment: str) -> list:
    return query(
        "SELECT * FROM config_items WHERE app_id = ? AND environment = ? ORDER BY key",
        (app_id, environment),
    )


def _rows_to_plain_map(rows: list) -> dict:
    """把数据库行转成 {key: {明文值, 类型, 范围, 是否密文}}。"""
    out = {}
    for r in rows:
        stored = r["value"]
        plain = crypto.decrypt(stored) if r["is_secret"] else stored
        out[r["key"]] = {
            "key": r["key"],
            "value": plain,
            "value_type": r["value_type"],
            "scope": r["scope"],
            "is_secret": bool(r["is_secret"]),
        }
    return out


def _item_out(row) -> dict:
    is_secret = bool(row["is_secret"])
    return {
        "key": row["key"],
        # 密文默认脱敏，任何列表/对比/版本接口都不在此返回明文
        "value": MASK if is_secret else row["value"],
        "value_type": row["value_type"],
        "scope": row["scope"],
        "is_secret": is_secret,
        "updated_at": row["updated_at"],
    }


def _latest_version(app_id: int, environment: str):
    return query_one(
        """SELECT v.id, v.version, v.change_type, v.base_version, v.comment,
                  v.created_at, u.name AS user_name
           FROM config_versions v LEFT JOIN users u ON u.id = v.user_id
           WHERE v.app_id = ? AND v.environment = ?
           ORDER BY v.version DESC LIMIT 1""",
        (app_id, environment),
    )


def _write_version(*, app_id: int, environment: str, user_id: int,
                   change_type: str, base_version: int | None,
                   comment: str, snapshot_items: list[dict], now: int) -> int:
    """追加一个版本并整体替换 config_items，须在调用方事务内执行。返回版本号。"""
    conn = get_conn()
    row = query_one(
        "SELECT COALESCE(MAX(version), 0) AS m FROM config_versions WHERE app_id = ? AND environment = ?",
        (app_id, environment),
    )
    version = row["m"] + 1
    # 快照中密文以密文形式保存（与 config_items 一致），避免明文落盘；回滚时再解密
    snapshot = json.dumps([{
        "key": it["key"], "value": it["_stored"],
        "value_type": it["value_type"], "scope": it["scope"],
        "is_secret": it["is_secret"],
    } for it in snapshot_items], ensure_ascii=False)
    cur = conn.execute(
        """INSERT INTO config_versions
           (app_id, environment, version, user_id, change_type, base_version,
            comment, snapshot, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (app_id, environment, version, user_id, change_type, base_version,
         comment.strip(), snapshot, now),
    )
    version_pk = cur.lastrowid
    conn.execute("DELETE FROM config_items WHERE app_id = ? AND environment = ?",
                 (app_id, environment))
    conn.executemany(
        """INSERT INTO config_items
           (app_id, environment, key, value, value_type, scope, is_secret, version_id, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [(app_id, environment, it["key"], it["_stored"], it["value_type"],
          it["scope"], 1 if it["is_secret"] else 0, version_pk, now)
         for it in snapshot_items],
    )
    return version, version_pk


def _audit_rows(*, app_id: int, environment: str, version: int | None, user_id: int,
                action: str, old_map: dict, new_items: list[dict],
                reason: str, now: int) -> None:
    """逐键写只追加留痕：新增 / 删除 / 修改各一行；密文值以 ****** 落留痕。"""
    conn = get_conn()
    new_map = {it["key"]: it for it in new_items}
    records = []
    for key, new in sorted(new_map.items()):
        old = old_map.get(key)
        if old is None:
            old_v, new_v = "", (MASK if new["is_secret"] else new["value"])
            changed = True
        else:
            changed = (old["value"] != new["value"] or old["value_type"] != new["value_type"]
                       or old["scope"] != new["scope"] or old["is_secret"] != new["is_secret"])
            old_v = MASK if old["is_secret"] else old["value"]
            new_v = MASK if new["is_secret"] else new["value"]
        if changed:
            records.append((key, old_v, new_v, new))
    for key, old in sorted(old_map.items()):
        if key not in new_map:
            records.append((key, MASK if old["is_secret"] else old["value"], "", old))
    conn.executemany(
        """INSERT INTO config_audit_logs
           (app_id, environment, version_id, user_id, action, config_key,
            old_value, new_value, value_type, scope, is_secret, reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [(app_id, environment, version, user_id, action, key, old_v, new_v,
          meta["value_type"], meta["scope"], 1 if meta["is_secret"] else 0,
          reason, now) for key, old_v, new_v, meta in records],
    )


def _normalize_items(items: list[ConfigItemIn]) -> list[dict]:
    cleaned, seen = [], set()
    for item in items:
        key = item.key.strip()
        if not key:
            continue
        if key in seen:
            raise err(400, f"配置键重复：{key}")
        seen.add(key)
        if item.value_type not in CONFIG_TYPES:
            raise err(400, f"非法值类型：{item.value_type}，可选：{'/'.join(CONFIG_TYPES)}")
        if item.scope not in CONFIG_SCOPES:
            raise err(400, f"非法生效范围：{item.scope}，可选：{'/'.join(CONFIG_SCOPES)}")
        try:
            value = _validate_value(item.value_type, item.value)
        except ValueError as exc:
            raise err(400, f"配置项「{key}」校验失败：{exc}")
        cleaned.append({
            "key": key,
            "value": value,
            "value_type": item.value_type,
            "scope": item.scope,
            "is_secret": item.is_secret,
        })
    return cleaned


# ---------------------------------------------------------------- 接口

@router.get("/config/envs")
def config_env_summary(app_id: int, user: dict = User):
    """应用各环境配置概览：当前版本号、配置项数、最近更新时间（供环境切换/对比入口）。"""
    app_row = get_app_checked(user, app_id)
    counts = {r["environment"]: dict(r) for r in query(
        """SELECT environment, COUNT(*) AS item_count, MAX(updated_at) AS updated_at
           FROM config_items WHERE app_id = ? GROUP BY environment""",
        (app_id,),
    )}
    out = []
    for env in ENVIRONMENTS:
        v = _latest_version(app_id, env)
        c = counts.get(env)
        out.append({
            "environment": env,
            "environment_label": ENV_LABELS[env],
            "item_count": c["item_count"] if c else 0,
            "updated_at": c["updated_at"] if c else None,
            "version": v["version"] if v else 0,
        })
    return {"app_id": app_id, "app_name": app_row["name"], "envs": out}


@router.get("/config/{environment}")
def config_list(app_id: int, environment: str, user: dict = User):
    check_env(environment)
    app_row = get_app_checked(user, app_id)
    rows = _current_rows(app_id, environment)
    v = _latest_version(app_id, environment)
    return {
        "app_id": app_id,
        "app_name": app_row["name"],
        "app_status": app_row["status"],
        "environment": environment,
        "environment_label": ENV_LABELS[environment],
        "read_only": app_row["status"] == TERMINAL_STATUS,
        "current_version": dict(v) if v else None,
        "items": [_item_out(r) for r in rows],
    }


@router.put("/config/{environment}")
def config_save(app_id: int, environment: str, body: ConfigSaveIn, user: dict = User):
    check_env(environment)
    app_row = get_app_checked(user, app_id)
    if app_row["status"] == TERMINAL_STATUS:
        raise err(400, "应用已下线（终态），配置只读，禁止修改")

    old_map = _rows_to_plain_map(_current_rows(app_id, environment))
    # 密文未改动：前端只有脱敏值，服务端以原明文回填，避免把 ****** 当成新值
    for item in body.items:
        if item.secret_kept:
            old = old_map.get(item.key.strip())
            if not old or not old["is_secret"]:
                raise err(400, f"配置项「{item.key.strip()}」不是已存在的密文，不能标记为密文保持")
            item.value = old["value"]

    items = _normalize_items(body.items)

    # 无变更直接拒绝，避免产生空版本
    new_sig = {(i["key"], i["value"], i["value_type"], i["scope"], i["is_secret"]) for i in items}
    old_sig = {(k, v["value"], v["value_type"], v["scope"], v["is_secret"]) for k, v in old_map.items()}
    if new_sig == old_sig:
        raise err(400, "配置未发生变化，未生成新版本")

    now = int(time.time())
    prev = _latest_version(app_id, environment)
    snapshot_items = [{**i, "_stored": crypto.encrypt(i["value"]) if i["is_secret"] else i["value"]}
                      for i in items]
    conn = get_conn()
    try:
        version, version_pk = _write_version(
            app_id=app_id, environment=environment, user_id=user["id"],
            change_type="update", base_version=prev["version"] if prev else None,
            comment=body.comment, snapshot_items=snapshot_items, now=now,
        )
        _audit_rows(app_id=app_id, environment=environment, version=version_pk, user_id=user["id"],
                    action=AUDIT_CONFIG_UPDATE, old_map=old_map, new_items=items,
                    reason=body.comment.strip(), now=now)
        added = sum(1 for i in items if i["key"] not in old_map)
        removed = sum(1 for k in old_map if k not in {i["key"] for i in items})
        kept = {i["key"]: i for i in items}
        modified = sum(
            1 for k, o in old_map.items()
            if k in kept and (o["value"] != kept[k]["value"] or o["value_type"] != kept[k]["value_type"]
                              or o["scope"] != kept[k]["scope"] or o["is_secret"] != kept[k]["is_secret"])
        )
        conn.execute(
            "INSERT INTO change_logs (app_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)",
            (app_id, user["id"], AUDIT_CONFIG_UPDATE,
             f"{ENV_LABELS[environment]}环境配置保存为 v{version}：新增 {added} / 修改 {modified} / 删除 {removed} 项",
             now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return config_list(app_id, environment, user)


@router.post("/config/{environment}/reveal")
def config_reveal(app_id: int, environment: str, body: RevealIn, user: dict = User):
    check_env(environment)
    get_app_checked(user, app_id)
    # 理由在服务端强制校验：仅前端拦截不算数
    reason = body.reason.strip()
    if len(reason) < 2:
        raise err(400, "查看密文明文必须填写不少于 2 个字的理由（服务端强制校验）")
    row = query_one(
        "SELECT * FROM config_items WHERE app_id = ? AND environment = ? AND key = ?",
        (app_id, environment, body.key.strip()),
    )
    if not row:
        raise err(404, f"配置项「{body.key.strip()}」不存在")
    if not row["is_secret"]:
        raise err(400, "该配置项不是密文，无需查看明文")
    try:
        plaintext = crypto.decrypt(row["value"])
    except ValueError as exc:
        raise err(500, str(exc))
    execute(
        """INSERT INTO config_audit_logs
           (app_id, environment, version_id, user_id, action, config_key,
            old_value, new_value, value_type, scope, is_secret, reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (app_id, environment, row["version_id"], user["id"], AUDIT_SECRET_VIEW,
         row["key"], "", "", row["value_type"], row["scope"], 1, reason, int(time.time())),
    )
    return {"key": row["key"], "value": plaintext}


@router.get("/config-diff/{left}/{right}")
def config_diff(app_id: int, left: str, right: str, user: dict = User):
    check_env(left)
    check_env(right)
    get_app_checked(user, app_id)
    left_rows = _rows_to_plain_map(_current_rows(app_id, left))
    right_rows = _rows_to_plain_map(_current_rows(app_id, right))
    keys = sorted(set(left_rows) | set(right_rows))
    items = []

    def view(m, k):
        if k not in m:
            return None
        it = m[k]
        # 密文在差异清单中同样脱敏，不泄露任何一侧明文
        return {**it, "value": MASK if it["is_secret"] else it["value"]}

    diff_count = 0
    for k in keys:
        l, r = left_rows.get(k), right_rows.get(k)
        if l and r:
            same = (l["value"] == r["value"] and l["value_type"] == r["value_type"]
                    and l["scope"] == r["scope"] and l["is_secret"] == r["is_secret"])
            status = "same" if same else "diff"
        elif l:
            status = "only_left"
        else:
            status = "only_right"
        if status != "same":
            diff_count += 1
        items.append({"key": k, "status": status,
                      "left": view(left_rows, k), "right": view(right_rows, k)})
    return {
        "left_env": left, "left_label": ENV_LABELS[left],
        "right_env": right, "right_label": ENV_LABELS[right],
        "items": items,
        "totals": {"keys": len(keys), "diff": diff_count,
                   "only_left": sum(1 for i in items if i["status"] == "only_left"),
                   "only_right": sum(1 for i in items if i["status"] == "only_right"),
                   "changed": sum(1 for i in items if i["status"] == "diff")},
    }


@router.get("/config/{environment}/versions")
def config_versions(app_id: int, environment: str, user: dict = User):
    check_env(environment)
    get_app_checked(user, app_id)
    rows = query(
        """SELECT v.id, v.version, v.change_type, v.base_version, v.comment,
                  v.created_at, u.name AS user_name,
                  (SELECT COUNT(*) FROM config_items ci WHERE ci.version_id = v.id) AS item_count
           FROM config_versions v LEFT JOIN users u ON u.id = v.user_id
           WHERE v.app_id = ? AND v.environment = ?
           ORDER BY v.version DESC""",
        (app_id, environment),
    )
    return [dict(r) for r in rows]


@router.get("/config/{environment}/versions/{version}")
def config_version_detail(app_id: int, environment: str, version: int, user: dict = User):
    check_env(environment)
    get_app_checked(user, app_id)
    row = query_one(
        """SELECT v.*, u.name AS user_name FROM config_versions v
           LEFT JOIN users u ON u.id = v.user_id
           WHERE v.app_id = ? AND v.environment = ? AND v.version = ?""",
        (app_id, environment, version),
    )
    if not row:
        raise err(404, f"{ENV_LABELS[environment]}环境不存在 v{version}")
    snapshot = json.loads(row["snapshot"])
    # 历史快照里的密文同样脱敏，看明文仍须走 reveal 二次确认
    items = [{
        "key": it["key"],
        "value": MASK if it["is_secret"] else it["value"],
        "value_type": it["value_type"],
        "scope": it["scope"],
        "is_secret": it["is_secret"],
    } for it in snapshot]
    return {
        "version": row["version"], "change_type": row["change_type"],
        "base_version": row["base_version"], "comment": row["comment"],
        "created_at": row["created_at"], "user_name": row["user_name"],
        "environment": environment, "environment_label": ENV_LABELS[environment],
        "items": items,
    }


@router.post("/config/{environment}/rollback")
def config_rollback(app_id: int, environment: str, body: RollbackIn, user: dict = User):
    check_env(environment)
    app_row = get_app_checked(user, app_id)
    if app_row["status"] == TERMINAL_STATUS:
        raise err(400, "应用已下线（终态），配置只读，禁止回滚")
    target = query_one(
        "SELECT * FROM config_versions WHERE app_id = ? AND environment = ? AND version = ?",
        (app_id, environment, body.version),
    )
    if not target:
        raise err(404, f"{ENV_LABELS[environment]}环境不存在 v{body.version}，无法回滚")
    current = _latest_version(app_id, environment)
    if current and current["version"] == target["version"]:
        raise err(400, f"v{target['version']} 就是当前版本，无需回滚")

    snap = json.loads(target["snapshot"])
    # 快照中的密文先解密再以新密文落盘；非密文原样恢复
    restored = []
    for it in snap:
        plain = crypto.decrypt(it["value"]) if it["is_secret"] else it["value"]
        restored.append({
            "key": it["key"], "value": plain,
            "value_type": it["value_type"], "scope": it["scope"],
            "is_secret": it["is_secret"],
        })
    now = int(time.time())
    reason_text = f"回滚到版本 v{target['version']}" + (f"：{body.comment.strip()}" if body.comment.strip() else "")
    snapshot_items = [{**i, "_stored": crypto.encrypt(i["value"]) if i["is_secret"] else i["value"]}
                      for i in restored]
    # 必须在写新版本前取当前内容，否则留痕的改前值会被新版本覆盖
    old_map = _rows_to_plain_map(_current_rows(app_id, environment))
    conn = get_conn()
    try:
        new_version, new_version_pk = _write_version(
            app_id=app_id, environment=environment, user_id=user["id"],
            change_type="rollback", base_version=target["version"],
            comment=reason_text, snapshot_items=snapshot_items, now=now,
        )
        _audit_rows(app_id=app_id, environment=environment, version=new_version_pk, user_id=user["id"],
                    action=AUDIT_CONFIG_ROLLBACK, old_map=old_map, new_items=restored,
                    reason=reason_text, now=now)
        conn.execute(
            "INSERT INTO change_logs (app_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)",
            (app_id, user["id"], AUDIT_CONFIG_ROLLBACK,
             f"{ENV_LABELS[environment]}环境配置从 v{current['version'] if current else 0} 回滚到 v{target['version']}，生成新版本 v{new_version}",
             now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return config_list(app_id, environment, user)
