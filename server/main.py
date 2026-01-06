"""Universal State Keeper backend."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import psycopg2
import psycopg2.extras
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


LOGGER = logging.getLogger("usk")
logging.basicConfig(level=logging.INFO)

DB_HOST = os.getenv("USK_DB_HOST", "localhost")
DB_PORT = int(os.getenv("USK_DB_PORT", "5432"))
DB_NAME = os.getenv("USK_DB_NAME", "usk")
DB_USER = os.getenv("USK_DB_USER", "postgres")
DB_PASSWORD = os.getenv("USK_DB_PASSWORD", "postgres")

DEFAULT_DB_NAME = os.getenv("USK_DB_DEFAULT", "postgres")
SQLITE_PATH = Path(os.getenv("USK_SQLITE_PATH", "usk.sqlite3"))

SCHEMA_SQL_POSTGRES = """
                      CREATE TABLE IF NOT EXISTS site_backups
                      (
                          id
                          SERIAL
                          PRIMARY
                          KEY,
                          domain
                          TEXT
                          UNIQUE
                          NOT
                          NULL,
                          cookies
                          JSONB
                          NOT
                          NULL,
                          local_storage
                          JSONB
                          NOT
                          NULL,
                          updated_at
                          TIMESTAMP
                          DEFAULT
                          CURRENT_TIMESTAMP
                      ); \
                      """

SCHEMA_SQL_SQLITE = """
                    CREATE TABLE IF NOT EXISTS site_backups
                    (
                        id
                        INTEGER
                        PRIMARY
                        KEY
                        AUTOINCREMENT,
                        domain
                        TEXT
                        UNIQUE
                        NOT
                        NULL,
                        cookies
                        TEXT
                        NOT
                        NULL,
                        local_storage
                        TEXT
                        NOT
                        NULL,
                        updated_at
                        TEXT
                        DEFAULT
                        CURRENT_TIMESTAMP
                    );
                    """


class BackupPayload(BaseModel):
    """站点备份信息

    :param domain: root domain.
    :param cookies: cookie list.
    :param local_storage: localStorage dict or origin map.

    :return: n/a.
    """

    domain: str = Field(..., min_length=1)
    cookies: List[Dict[str, Any]]
    local_storage: Dict[str, Any]


class BackupResponse(BaseModel):
    """站点恢复信息

    :param domain: root domain.
    :param cookies: cookie list.
    :param local_storage: localStorage dict.
    :param updated_at: timestamp.

    :return: n/a.
    """

    domain: str
    cookies: List[Dict[str, Any]]
    local_storage: Dict[str, Any]
    updated_at: str


class BackupStatusResponse(BaseModel):
    """站点备份状态

    :param domain: root domain.
    :param exists: backup exists.
    :param updated_at: timestamp when exists.

    :return: n/a.
    """

    domain: str
    exists: bool
    updated_at: Optional[str] = None


class StorageBackend:
    """存储后端抽象层"""

    def ensure_schema(self) -> None:
        """初始化数据库和表结构

        :return: n/a.
        """

        raise NotImplementedError

    def fetch_status(self, domain: str) -> Optional[str]:
        """读取备份状态

        :param domain: root domain.
        :return: updated_at string when exists.
        """

        raise NotImplementedError

    def save_backup(self, payload: BackupPayload) -> None:
        """保存备份

        :param payload: backup payload.
        :return: n/a.
        """

        raise NotImplementedError

    def restore_backup(self, domain: str) -> Optional[Dict[str, Any]]:
        """恢复备份

        :param domain: root domain.
        :return: backup payload data.
        """

        raise NotImplementedError

    def delete_backup(self, domain: str) -> bool:
        """删除备份

        :param domain: root domain.
        :return: delete result.
        """

        raise NotImplementedError


class PostgresStorage(StorageBackend):
    """PostgreSQL 存储后端"""

    def __init__(self) -> None:
        self._host = DB_HOST
        self._port = DB_PORT
        self._db_name = DB_NAME
        self._user = DB_USER
        self._password = DB_PASSWORD
        self._default_db = DEFAULT_DB_NAME

    def _connect(self, dbname: str) -> psycopg2.extensions.connection:
        return psycopg2.connect(
            host=self._host,
            port=self._port,
            dbname=dbname,
            user=self._user,
            password=self._password,
        )

    def ensure_schema(self) -> None:
        try:
            with self._connect(self._default_db) as conn:
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT 1 FROM pg_database WHERE datname = %s",
                        (self._db_name,),
                    )
                    exists = cur.fetchone() is not None
                    if not exists:
                        cur.execute(f'CREATE DATABASE "{self._db_name}"')
                        LOGGER.info("Database created: %s", self._db_name)
        except Exception as exc:
            LOGGER.exception("Failed to ensure postgres database")
            raise RuntimeError("Failed to ensure postgres database") from exc

        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor() as cur:
                    cur.execute(SCHEMA_SQL_POSTGRES)
            LOGGER.info("Postgres schema ensured")
        except Exception as exc:
            LOGGER.exception("Failed to ensure postgres schema")
            raise RuntimeError("Failed to ensure postgres schema") from exc

    def fetch_status(self, domain: str) -> Optional[str]:
        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(
                        "SELECT domain, updated_at FROM site_backups WHERE domain = %s",
                        (domain,),
                    )
                    row = cur.fetchone()
        except Exception as exc:
            LOGGER.exception("Failed to check backup status")
            raise RuntimeError("Failed to check backup status") from exc

        if not row:
            return None

        return row["updated_at"].isoformat()

    def save_backup(self, payload: BackupPayload) -> None:
        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO site_backups (domain, cookies, local_storage)
                        VALUES (%s, %s, %s) ON CONFLICT (domain)
                        DO
                        UPDATE SET
                            cookies = EXCLUDED.cookies,
                            local_storage = EXCLUDED.local_storage,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (
                            payload.domain,
                            psycopg2.extras.Json(payload.cookies),
                            psycopg2.extras.Json(payload.local_storage),
                        ),
                    )
        except Exception as exc:
            LOGGER.exception("Failed to save backup")
            raise RuntimeError("Failed to save backup") from exc

    def restore_backup(self, domain: str) -> Optional[Dict[str, Any]]:
        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(
                        "SELECT domain, cookies, local_storage, updated_at "
                        "FROM site_backups WHERE domain = %s",
                        (domain,),
                    )
                    row = cur.fetchone()
        except Exception as exc:
            LOGGER.exception("Failed to restore backup")
            raise RuntimeError("Failed to restore backup") from exc

        if not row:
            return None

        return {
            "domain": row["domain"],
            "cookies": row["cookies"],
            "local_storage": row["local_storage"],
            "updated_at": row["updated_at"].isoformat(),
        }

    def delete_backup(self, domain: str) -> bool:
        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM site_backups WHERE domain = %s RETURNING domain",
                        (domain,),
                    )
                    row = cur.fetchone()
        except Exception as exc:
            LOGGER.exception("Failed to delete backup")
            raise RuntimeError("Failed to delete backup") from exc

        return row is not None


class SqliteStorage(StorageBackend):
    """SQLite 存储后端"""

    def __init__(self, path: Path) -> None:
        self._path = path

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self._path))

    def ensure_schema(self) -> None:
        try:
            if self._path.parent != Path("."):
                self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.execute(SCHEMA_SQL_SQLITE)
            LOGGER.info("SQLite schema ensured at %s", self._path)
        except Exception as exc:
            LOGGER.exception("Failed to ensure sqlite schema")
            raise RuntimeError("Failed to ensure sqlite schema") from exc

    def fetch_status(self, domain: str) -> Optional[str]:
        try:
            with self._connect() as conn:
                conn.row_factory = sqlite3.Row
                cur = conn.execute(
                    "SELECT domain, updated_at FROM site_backups WHERE domain = ?",
                    (domain,),
                )
                row = cur.fetchone()
        except Exception as exc:
            LOGGER.exception("Failed to check backup status")
            raise RuntimeError("Failed to check backup status") from exc

        if not row:
            return None

        return row["updated_at"]

    def save_backup(self, payload: BackupPayload) -> None:
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO site_backups (domain, cookies, local_storage)
                    VALUES (?, ?, ?) ON CONFLICT(domain) DO
                    UPDATE SET
                        cookies = excluded.cookies,
                        local_storage = excluded.local_storage,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (
                        payload.domain,
                        json.dumps(payload.cookies),
                        json.dumps(payload.local_storage),
                    ),
                )
        except Exception as exc:
            LOGGER.exception("Failed to save backup")
            raise RuntimeError("Failed to save backup") from exc

    def restore_backup(self, domain: str) -> Optional[Dict[str, Any]]:
        try:
            with self._connect() as conn:
                conn.row_factory = sqlite3.Row
                cur = conn.execute(
                    "SELECT domain, cookies, local_storage, updated_at "
                    "FROM site_backups WHERE domain = ?",
                    (domain,),
                )
                row = cur.fetchone()
        except Exception as exc:
            LOGGER.exception("Failed to restore backup")
            raise RuntimeError("Failed to restore backup") from exc

        if not row:
            return None

        return {
            "domain": row["domain"],
            "cookies": json.loads(row["cookies"]),
            "local_storage": json.loads(row["local_storage"]),
            "updated_at": row["updated_at"],
        }

    def delete_backup(self, domain: str) -> bool:
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM site_backups WHERE domain = ?",
                    (domain,),
                )
                deleted = cur.rowcount > 0
        except Exception as exc:
            LOGGER.exception("Failed to delete backup")
            raise RuntimeError("Failed to delete backup") from exc

        return deleted


STORAGE: Optional[StorageBackend] = None


def init_storage() -> StorageBackend:
    """初始化存储后端，优先 PostgreSQL，失败回退 SQLite"""

    postgres = PostgresStorage()
    try:
        postgres.ensure_schema()
        LOGGER.info("Using Postgres storage")
        return postgres
    except Exception as exc:
        LOGGER.warning("Postgres unavailable, falling back to SQLite: %s", exc)

    sqlite_storage = SqliteStorage(SQLITE_PATH)
    sqlite_storage.ensure_schema()
    LOGGER.info("Using SQLite storage")
    return sqlite_storage


def get_storage() -> StorageBackend:
    """获取当前存储后端

    :return: storage backend.
    """

    if STORAGE is None:
        raise RuntimeError("Storage backend not initialized")
    return STORAGE


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期管理

    :return: n/a.
    """

    global STORAGE
    STORAGE = init_storage()
    yield


app = FastAPI(title="Universal State Keeper", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> Dict[str, str]:
    """Health check

    :return: status.
    """

    return {"status": "ok"}


@app.post("/init")
async def init_database() -> Dict[str, str]:
    """手动初始化数据库

    :return: result message.
    """

    storage = get_storage()
    storage.ensure_schema()
    return {"status": "ok"}


@app.get("/status/{domain}", response_model=BackupStatusResponse)
async def backup_status(domain: str) -> BackupStatusResponse:
    """查看备份状态

    :param domain: root domain.
    :return: backup status.
    """

    try:
        storage = get_storage()
        updated_at = storage.fetch_status(domain)
    except Exception as exc:
        LOGGER.exception("Failed to check backup status")
        raise HTTPException(status_code=500, detail="Failed to check backup status") from exc

    if not updated_at:
        return BackupStatusResponse(domain=domain, exists=False, updated_at=None)

    return BackupStatusResponse(
        domain=domain,
        exists=True,
        updated_at=updated_at,
    )


@app.post("/backup")
async def backup_site(payload: BackupPayload) -> Dict[str, str]:
    """保存站点状态

    :param payload: backup payload.
    :return: result message.
    """

    try:
        storage = get_storage()
        storage.save_backup(payload)
        LOGGER.info("Backup saved for %s", payload.domain)
    except Exception as exc:
        LOGGER.exception("Failed to save backup")
        raise HTTPException(status_code=500, detail="Failed to save backup") from exc

    return {"status": "ok"}


@app.get("/restore/{domain}", response_model=BackupResponse)
async def restore_site(domain: str) -> BackupResponse:
    """读取站点状态

    :param domain: root domain.
    :return: backup data.
    """

    try:
        storage = get_storage()
        row = storage.restore_backup(domain)
    except Exception as exc:
        LOGGER.exception("Failed to restore backup")
        raise HTTPException(status_code=500, detail="Failed to restore backup") from exc

    if not row:
        raise HTTPException(status_code=404, detail="Backup not found")

    return BackupResponse(
        domain=row["domain"],
        cookies=row["cookies"],
        local_storage=row["local_storage"],
        updated_at=row["updated_at"],
    )


@app.delete("/backup/{domain}")
async def delete_backup(domain: str) -> Dict[str, Any]:
    """删除站点备份

    :param domain: root domain.
    :return: delete result.
    """

    try:
        storage = get_storage()
        deleted = storage.delete_backup(domain)
    except Exception as exc:
        LOGGER.exception("Failed to delete backup")
        raise HTTPException(status_code=500, detail="Failed to delete backup") from exc

    return {"status": "ok", "deleted": deleted}


if __name__ == '__main__':
    uvicorn.run(app, host="0.0.0.0", port=8000)
