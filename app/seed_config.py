"""配置档案演示数据（独立幂等）：多环境差异、历史版本、密文与明文查看留痕。

- 支付网关：dev/prod 存在 仅开发有 / 仅生产有 / 值不同 / 密文 等各类差异，prod 有 v1→v2 可回滚；
- 会员中心：dev/prod 常规差异。
任何已有配置版本的库都不会重复写入。
"""
import json
import time

from . import crypto
from .db import (
    AUDIT_CONFIG_ROLLBACK, AUDIT_CONFIG_UPDATE, AUDIT_SECRET_VIEW, execute,
    query_one,
)

DAY = 86400


def _item(key, value, value_type="string", scope="global", is_secret=False):
    return {"key": key, "value": value, "value_type": value_type,
            "scope": scope, "is_secret": is_secret}


# 支付网关（用户名 zhangwei）
_PAY_DEV = [
    _item("DB_HOST", "10.0.3.31:3306"),
    _item("DB_PASSWORD", "Dev@123456", is_secret=True),
    _item("REDIS_URL", "redis://redis-dev:6379/0"),
    _item("LOG_LEVEL", "DEBUG"),
    _item("POOL_SIZE", "8", "number"),
    _item("DEBUG_TRACE", "true", "boolean"),          # 仅开发有
]
_PAY_PROD_V1 = [
    _item("DB_HOST", "mysql.pay.internal:3306"),
    _item("DB_PASSWORD", "Pay@Prod-2025", is_secret=True),
    _item("REDIS_URL", "redis://redis-prod:6379/1"),
    _item("LOG_LEVEL", "INFO"),
    _item("POOL_SIZE", "32", "number"),
]
_PAY_PROD_V2 = [
    _item("DB_HOST", "mysql.pay.internal:3306"),
    _item("DB_PASSWORD", "Pay@Prod-2026!", is_secret=True),
    _item("REDIS_URL", "redis://redis-prod:6379/1"),
    _item("LOG_LEVEL", "WARN"),
    _item("POOL_SIZE", "64", "number"),
    _item("MQ_BROKER", "kafka://kafka-prod:9092"),    # 仅生产有
    _item("TIMEOUT_MS", "3000", "number", "service"),
]

# 会员中心（用户名 wangqiang）
_GROWTH_DEV = [
    _item("DB_HOST", "10.1.2.8:3306"),
    _item("DB_PASSWORD", "Growth@Dev", is_secret=True),
    _item("REDIS_URL", "redis://growth-dev:6379/0"),
    _item("LOG_LEVEL", "DEBUG"),
]
_GROWTH_PROD = [
    _item("DB_HOST", "mysql.growth.internal:3306"),
    _item("DB_PASSWORD", "Growth@Prod-2026", is_secret=True),
    _item("REDIS_URL", "redis://growth-prod:6379/0"),
    _item("LOG_LEVEL", "INFO"),
    _item("API_RATE_LIMIT", "1000", "number", "service"),
]


def _stored(it: dict) -> str:
    return crypto.encrypt(it["value"]) if it["is_secret"] else it["value"]


def _mask(it: dict) -> str:
    return "******" if it["is_secret"] else it["value"]


def _diff_records(old: list[dict], new: list[dict]) -> list[tuple]:
    """返回 (key, old_masked, new_masked, meta) 逐键差异。"""
    old_map = {i["key"]: i for i in old}
    new_map = {i["key"]: i for i in new}
    records = []
    for key, it in sorted(new_map.items()):
        o = old_map.get(key)
        if o is None:
            records.append((key, "", _mask(it), it))
        elif (o["value"], o["value_type"], o["scope"], o["is_secret"]) != \
                (it["value"], it["value_type"], it["scope"], it["is_secret"]):
            records.append((key, _mask(o), _mask(it), it))
    for key, o in sorted(old_map.items()):
        if key not in new_map:
            records.append((key, _mask(o), "", o))
    return records


def _seed_env(app_id: int, user_id: int, env: str, versions: list[tuple], now: int) -> None:
    """versions: [(change_type, base_version, comment, created_ts, items), ...]"""
    prev_items: list[dict] = []
    for idx, (change_type, base_ver, comment, ts, items) in enumerate(versions, start=1):
        # 快照中的密文以密文形式保存（与运行时一致），回滚时再解密
        snap_items = [{**it, "value": _stored(it)} for it in items]
        snap = json.dumps(snap_items, ensure_ascii=False)
        vcur = execute(
            """INSERT INTO config_versions
               (app_id, environment, version, user_id, change_type, base_version,
                comment, snapshot, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (app_id, env, idx, user_id, change_type, base_ver, comment, snap, ts),
        )
        version_pk = vcur.lastrowid
        execute(
            "DELETE FROM config_items WHERE app_id = ? AND environment = ?",
            (app_id, env),
        )
        for it in items:
            execute(
                """INSERT INTO config_items
                   (app_id, environment, key, value, value_type, scope, is_secret, version_id, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (app_id, env, it["key"], _stored(it), it["value_type"], it["scope"],
                 1 if it["is_secret"] else 0, version_pk, ts),
            )
        records = _diff_records(prev_items, items)
        for key, old_v, new_v, meta in records:
            execute(
                """INSERT INTO config_audit_logs
                   (app_id, environment, version_id, user_id, action, config_key,
                    old_value, new_value, value_type, scope, is_secret, reason, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (app_id, env, version_pk, user_id,
                 AUDIT_CONFIG_ROLLBACK if change_type == "rollback" else AUDIT_CONFIG_UPDATE,
                 key, old_v, new_v, meta["value_type"], meta["scope"],
                 1 if meta["is_secret"] else 0, comment, ts),
            )
        prev_items = items


def seed_config_if_empty() -> bool:
    if query_one("SELECT id FROM config_versions LIMIT 1"):
        return False
    pay = query_one("SELECT id FROM applications WHERE name = ?", ("支付网关",))
    growth = query_one("SELECT id FROM applications WHERE name = ?", ("会员中心",))
    if not pay or not growth:
        return False  # 应用种子尚未执行，等下次启动
    zhangwei = query_one("SELECT id FROM users WHERE username = ?", ("zhangwei",))
    wangqiang = query_one("SELECT id FROM users WHERE username = ?", ("wangqiang",))
    now = int(time.time())

    _seed_env(pay["id"], zhangwei["id"], "dev", [
        ("update", None, "初始化开发环境配置", now - 8 * DAY, _PAY_DEV),
    ], now)
    _seed_env(pay["id"], zhangwei["id"], "prod", [
        ("update", None, "生产配置初始化", now - 12 * DAY, _PAY_PROD_V1),
        ("update", 1, "大促扩容：连接池 32→64，日志降级 WARN，新增 MQ 与超时配置", now - 2 * DAY, _PAY_PROD_V2),
    ], now)
    # 一条密文查看留痕（服务端要求理由的演示样例）
    prod_v2 = query_one(
        "SELECT id FROM config_versions WHERE app_id = ? AND environment = 'prod' AND version = 2",
        (pay["id"],),
    )
    execute(
        """INSERT INTO config_audit_logs
           (app_id, environment, version_id, user_id, action, config_key,
            old_value, new_value, value_type, scope, is_secret, reason, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (pay["id"], "prod", prod_v2["id"] if prod_v2 else None, zhangwei["id"],
         AUDIT_SECRET_VIEW, "DB_PASSWORD",
         "", "", "string", "global", 1,
         "生产故障排查：支付超时告警，核对数据库连接凭据", now - 1 * DAY - 3600),
    )

    _seed_env(growth["id"], wangqiang["id"], "dev", [
        ("update", None, "初始化开发环境配置", now - 6 * DAY, _GROWTH_DEV),
    ], now)
    _seed_env(growth["id"], wangqiang["id"], "prod", [
        ("update", None, "生产配置初始化", now - 9 * DAY, _GROWTH_PROD),
    ], now)
    return True
