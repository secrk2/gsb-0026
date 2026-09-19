"""织云系统 - SQLite 数据层。

生命周期状态机（只能向前流转，下线为终态）：
    在研 developing -> 上线 online -> 维保 maintenance -> 下线 offline(终态)
"""
import os
import sqlite3
import threading

DB_PATH = os.environ.get(
    "DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "zhiyun.db")
)

ENVIRONMENTS = ["dev", "test", "staging", "prod"]
ENV_LABELS = {"dev": "开发", "test": "测试", "staging": "预发", "prod": "生产"}

STATUSES = ["developing", "online", "maintenance", "offline"]
STATUS_LABELS = {
    "developing": "在研",
    "online": "上线",
    "maintenance": "维保",
    "offline": "下线",
}
STATUS_ORDER = {s: i for i, s in enumerate(STATUSES)}
TERMINAL_STATUS = "offline"

CLUSTERS = ["华东1集群", "华北2集群", "华南1集群", "西南灾备集群"]

# 配置项值类型与生效范围
CONFIG_TYPES = ["string", "number", "boolean", "json"]
CONFIG_TYPE_LABELS = {"string": "字符串", "number": "数值", "boolean": "布尔", "json": "JSON"}
CONFIG_SCOPES = ["global", "service", "instance"]
CONFIG_SCOPE_LABELS = {"global": "全局", "service": "服务级", "instance": "实例级"}

# 配置留痕动作
AUDIT_CONFIG_UPDATE = "配置更新"
AUDIT_CONFIG_ROLLBACK = "配置回滚"
AUDIT_SECRET_VIEW = "明文查看"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS business_lines (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username         TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    business_line_id INTEGER REFERENCES business_lines(id),
    token            TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS applications (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    business_line_id INTEGER NOT NULL REFERENCES business_lines(id),
    owner_id         INTEGER REFERENCES users(id),
    cluster          TEXT NOT NULL,
    environment      TEXT NOT NULL CHECK (environment IN ('dev','test','staging','prod')),
    status           TEXT NOT NULL DEFAULT 'developing'
                     CHECK (status IN ('developing','online','maintenance','offline')),
    description      TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (business_line_id, name)
);

CREATE TABLE IF NOT EXISTS env_vars (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL DEFAULT '',
    UNIQUE (app_id, key)
);

CREATE TABLE IF NOT EXISTS change_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id     INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id),
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

-- 配置档案：按 应用 + 环境 维度管理配置项（当前生效版本的快照行）
CREATE TABLE IF NOT EXISTS config_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id      INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    environment TEXT NOT NULL CHECK (environment IN ('dev','test','staging','prod')),
    key         TEXT NOT NULL,
    value       TEXT NOT NULL DEFAULT '',   -- 密文以 enc:v1: 前缀存储
    value_type  TEXT NOT NULL DEFAULT 'string'
                CHECK (value_type IN ('string','number','boolean','json')),
    scope       TEXT NOT NULL DEFAULT 'global'
                CHECK (scope IN ('global','service','instance')),
    is_secret   INTEGER NOT NULL DEFAULT 0,
    version_id  INTEGER,
    updated_at  INTEGER NOT NULL,
    UNIQUE (app_id, environment, key)
);

-- 配置版本：每次保存 / 回滚追加一条，版本号只增不减
CREATE TABLE IF NOT EXISTS config_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id      INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    environment TEXT NOT NULL,
    version     INTEGER NOT NULL,
    user_id     INTEGER REFERENCES users(id),
    change_type TEXT NOT NULL DEFAULT 'update' CHECK (change_type IN ('update','rollback')),
    base_version INTEGER,          -- 回滚时指向被回滚到的目标版本；普通更新指向上一版
    comment     TEXT NOT NULL DEFAULT '',
    snapshot    TEXT NOT NULL,     -- 该版本完整配置快照 JSON
    created_at  INTEGER NOT NULL,
    UNIQUE (app_id, environment, version)
);

-- 配置变更留痕：逐键级流水 + 明文查看记录（只追加，永不更新/删除）
CREATE TABLE IF NOT EXISTS config_audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id        INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    environment   TEXT NOT NULL,
    version_id    INTEGER,
    user_id       INTEGER REFERENCES users(id),
    action        TEXT NOT NULL,   -- 配置更新 / 配置回滚 / 明文查看
    config_key    TEXT NOT NULL DEFAULT '',
    old_value     TEXT NOT NULL DEFAULT '',
    new_value     TEXT NOT NULL DEFAULT '',
    value_type    TEXT NOT NULL DEFAULT '',
    scope         TEXT NOT NULL DEFAULT '',
    is_secret     INTEGER NOT NULL DEFAULT 0,
    reason        TEXT NOT NULL DEFAULT '',  -- 明文查看理由（服务端强制非空）
    created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_bl ON applications(business_line_id);
CREATE INDEX IF NOT EXISTS idx_apps_owner ON applications(owner_id);
CREATE INDEX IF NOT EXISTS idx_logs_app ON change_logs(app_id);
CREATE INDEX IF NOT EXISTS idx_logs_time ON change_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cfg_app_env ON config_items(app_id, environment);
CREATE INDEX IF NOT EXISTS idx_cfgver_app_env ON config_versions(app_id, environment, version);
CREATE INDEX IF NOT EXISTS idx_cfgaudit_app ON config_audit_logs(app_id, environment, created_at);
CREATE INDEX IF NOT EXISTS idx_cfgaudit_time ON config_audit_logs(created_at);
"""

_local = threading.local()


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()


def query(sql: str, params: tuple = ()) -> list:
    return get_conn().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()):
    return get_conn().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    cur = get_conn().execute(sql, params)
    get_conn().commit()
    return cur
