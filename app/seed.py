"""初始数据：4 条业务线、9 个用户、24 个应用（覆盖 在研/上线/维保/下线 全部状态）。

部分应用故意缺失负责人或环境变量，用于控制台红点提示演示。
变更日志时间相对启动时刻生成，保证"近 7 天有变更"开箱即有数据。
"""
import time

from .db import STATUS_LABELS, execute, query_one

DAY = 86400

BUSINESS_LINES = [
    ("支付结算", "pay"),
    ("用户增长", "growth"),
    ("供应链", "supply"),
    ("数据平台", "data"),
]

# (username, 姓名, 角色, 业务线 code 或 None)
USERS = [
    ("admin",  "系统管理员", "admin",  None),
    ("zhangwei", "张伟", "member", "pay"),
    ("lina",     "李娜", "member", "pay"),
    ("wangqiang", "王强", "member", "growth"),
    ("chenchen", "陈晨", "member", "growth"),
    ("liuyang",  "刘洋", "member", "supply"),
    ("zhaomin",  "赵敏", "member", "supply"),
    ("sunlei",   "孙磊", "member", "data"),
    ("zhouting", "周婷", "member", "data"),
]

# (应用名, 业务线, 负责人 username 或 None, 集群, 环境, 状态, 描述, 环境变量数, 距今天数)
APPS = [
    # 支付结算
    ("支付网关",        "pay",    "zhangwei", "华东1集群", "prod",    "online",      "统一收单与路由网关", 5, 1),
    ("清结算中心",      "pay",    "lina",     "华东1集群", "prod",    "maintenance", "T+1 清分结算批处理", 4, 3),
    ("风控实时引擎",    "pay",    "zhangwei", "华北2集群", "prod",    "online",      "实时交易风控决策", 6, 6),
    ("对账平台",        "pay",    None,       "华南1集群", "test",    "developing",  "渠道对账与差错处理", 0, 2),
    ("收银台 H5",       "pay",    "lina",     "华东1集群", "staging", "online",      "移动端收银台", 3, 20),
    ("代付通道服务",    "pay",    None,       "华北2集群", "prod",    "offline",     "已迁移至新代付平台", 2, 40),
    # 用户增长
    ("会员中心",        "growth", "wangqiang", "华东1集群", "prod",   "online",      "会员等级与权益", 5, 4),
    ("裂变活动平台",    "growth", "chenchen", "华南1集群", "staging", "developing",  "老带新裂变活动配置", 0, 0),
    ("消息推送中心",    "growth", "wangqiang", "华北2集群", "prod",   "maintenance", "Push/短信/站内信", 4, 5),
    ("积分商城",        "growth", None,        "华东1集群", "test",   "developing",  "积分兑换商城", 3, 12),
    ("增长实验平台",    "growth", "chenchen", "华北2集群", "dev",     "developing",  "AB 实验与分流", 0, 1),
    ("老客召回系统",    "growth", "wangqiang", "华南1集群", "prod",   "offline",     "已被消息推送中心替代", 1, 60),
    # 供应链
    ("订单履约中心",    "supply", "liuyang",  "华东1集群", "prod",    "online",      "订单寻源与履约调度", 6, 2),
    ("仓储管理 WMS",    "supply", "zhaomin",  "华北2集群", "prod",    "maintenance", "仓内作业管理", 5, 8),
    ("运输调度 TMS",    "supply", "liuyang",  "华南1集群", "staging", "online",      "干线与城配调度", 4, 15),
    ("供应商门户",      "supply", None,       "华东1集群", "test",    "developing",  "供应商协同门户", 0, 3),
    ("库存中台",        "supply", "zhaomin",  "华北2集群", "prod",    "online",      "全渠道库存共享", 5, 6),
    ("旧采购系统",      "supply", "liuyang",  "西南灾备集群", "prod", "offline",     "采购 1.0，已下线", 2, 90),
    # 数据平台
    ("实时数仓",        "data",   "sunlei",   "华北2集群", "prod",    "online",      "Flink 实时数仓", 6, 1),
    ("离线调度平台",    "data",   "zhouting", "华北2集群", "prod",    "maintenance", "离线任务调度", 4, 9),
    ("BI 报表平台",     "data",   "sunlei",   "华东1集群", "prod",    "online",      "经营分析报表", 3, 25),
    ("数据质量中心",    "data",   None,       "华南1集群", "dev",     "developing",  "数据质量规则引擎", 0, 0),
    ("标签画像平台",    "data",   "zhouting", "华东1集群", "staging", "online",      "用户标签与画像", 5, 4),
    ("日志采集 Agent",  "data",   "sunlei",   "西南灾备集群", "prod", "offline",     "已被 Filebeat 方案替代", 2, 120),
]

ENV_VAR_POOL = [
    ("DB_HOST", "mysql.internal"),
    ("DB_PASSWORD", "****"),
    ("REDIS_URL", "redis://redis.internal:6379/0"),
    ("MQ_BROKER", "kafka://kafka.internal:9092"),
    ("LOG_LEVEL", "INFO"),
    ("OSS_BUCKET", "app-assets"),
]


def seed_if_empty() -> bool:
    """数据库为空时写入初始数据。返回是否执行了种子写入。"""
    if query_one("SELECT id FROM business_lines LIMIT 1"):
        return False

    now = int(time.time())

    bl_ids = {}
    for name, code in BUSINESS_LINES:
        cur = execute("INSERT INTO business_lines (name, code) VALUES (?, ?)", (name, code))
        bl_ids[code] = cur.lastrowid

    user_ids = {}
    for username, name, role, bl_code in USERS:
        cur = execute(
            "INSERT INTO users (username, name, role, business_line_id, token) VALUES (?,?,?,?,?)",
            (username, name, role, bl_ids.get(bl_code), f"tok-{username}-zhiyun"),
        )
        user_ids[username] = cur.lastrowid

    for (app_name, bl_code, owner, cluster, env, status, desc,
         env_count, days_ago) in APPS:
        created = now - days_ago * DAY - 3600
        cur = execute(
            """INSERT INTO applications
               (name, business_line_id, owner_id, cluster, environment, status,
                description, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (app_name, bl_ids[bl_code], user_ids.get(owner), cluster, env, status,
             desc, created, now - days_ago * DAY),
        )
        app_id = cur.lastrowid
        for key, value in ENV_VAR_POOL[:env_count]:
            execute("INSERT INTO env_vars (app_id, key, value) VALUES (?,?,?)",
                    (app_id, key, value))
        execute(
            "INSERT INTO change_logs (app_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)",
            (app_id, user_ids.get(owner), "创建应用", f"应用「{app_name}」创建，初始状态：在研",
             created),
        )
        # 近 7 天内有变更的应用：补一条状态流转日志，让控制台开箱有数据
        if days_ago <= 6 and status != "developing":
            execute(
                "INSERT INTO change_logs (app_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)",
                (app_id, user_ids.get(owner) or user_ids["admin"], "状态变更",
                 f"状态流转至「{STATUS_LABELS[status]}」", now - days_ago * DAY),
            )
    return True
