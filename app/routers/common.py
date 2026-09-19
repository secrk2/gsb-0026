"""配置 / 留痕路由共用的应用定位与权限校验。"""
from ..auth import check_bl_scope, err
from ..db import ENVIRONMENTS, query_one


def get_app_checked(user: dict, app_id: int) -> dict:
    """应用存在性（404）+ 业务线越权（403）校验。"""
    row = query_one("SELECT * FROM applications WHERE id = ?", (app_id,))
    if not row:
        raise err(404, f"应用 #{app_id} 不存在或已被删除")
    check_bl_scope(user, row["business_line_id"])
    return dict(row)


def check_env(environment: str) -> str:
    if environment not in ENVIRONMENTS:
        raise err(400, f"非法环境：{environment}，可选：{'/'.join(ENVIRONMENTS)}")
    return environment
