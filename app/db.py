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

CREATE INDEX IF NOT EXISTS idx_apps_bl ON applications(business_line_id);
CREATE INDEX IF NOT EXISTS idx_apps_owner ON applications(owner_id);
CREATE INDEX IF NOT EXISTS idx_logs_app ON change_logs(app_id);
CREATE INDEX IF NOT EXISTS idx_logs_time ON change_logs(created_at);
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
