"""认证、鉴权与权限收窄（供 main 与各业务路由模块共用）。"""
from fastapi import Depends, Header, HTTPException

from .db import query_one


def err(status_code: int, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail=message)


def current_user(x_token: str = Header(default="")) -> dict:
    if not x_token:
        raise err(401, "未登录：缺少访问令牌")
    row = query_one(
        """SELECT u.id, u.username, u.name, u.role, u.business_line_id,
                  b.name AS business_line_name
           FROM users u LEFT JOIN business_lines b ON b.id = u.business_line_id
           WHERE u.token = ?""",
        (x_token,),
    )
    if not row:
        raise err(401, "登录已失效，请重新登录")
    return dict(row)


User = Depends(current_user)


def is_admin(user: dict) -> bool:
    return user["role"] == "admin"


def check_bl_scope(user: dict, business_line_id: int) -> None:
    """普通成员只能操作本业务线的数据，越权直接 403。"""
    if is_admin(user):
        return
    if user["business_line_id"] != business_line_id:
        bl = query_one("SELECT name FROM business_lines WHERE id = ?", (business_line_id,))
        name = bl["name"] if bl else f"#{business_line_id}"
        raise err(403, f"无权访问其他业务线（{name}）的数据，仅可操作本业务线（{user['business_line_name']}）")
