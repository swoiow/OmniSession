"""OmniSession backend."""

from __future__ import annotations

import hashlib
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
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, Header, HTTPException
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
KDF_ITERATIONS = int(os.getenv("USK_KDF_ITERATIONS", "200000"))
KDF_SALT_BYTES = 16
KDF_NONCE_BYTES = 12

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
                          payload
                          BYTEA
                          NOT
                          NULL,
                          encrypted
                          BOOLEAN
                          NOT
                          NULL
                          DEFAULT
                          FALSE,
                          salt
                          BYTEA,
                          nonce
                          BYTEA,
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
                        payload
                        BLOB
                        NOT
                        NULL,
                        encrypted
                        INTEGER
                        NOT
                        NULL
                        DEFAULT
                        0,
                        salt
                        BLOB,
                        nonce
                        BLOB,
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


def derive_key(password: str, salt: bytes) -> bytes:
    """派生加密密钥

    :param password: encryption password.
    :param salt: random salt.

    :return: derived key bytes.
    """

    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        KDF_ITERATIONS,
        dklen=32,
    )


def encrypt_payload(payload: Dict[str, Any], password: str) -> Dict[str, bytes]:
    """加密 payload

    :param payload: payload dict.
    :param password: encryption password.

    :return: encrypted blob with salt/nonce.
    """

    salt = os.urandom(KDF_SALT_BYTES)
    nonce = os.urandom(KDF_NONCE_BYTES)
    key = derive_key(password, salt)
    aesgcm = AESGCM(key)
    plaintext = json.dumps(payload).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return {"payload": ciphertext, "salt": salt, "nonce": nonce}


def decrypt_payload(payload: bytes, password: str, salt: bytes, nonce: bytes) -> Dict[str, Any]:
    """解密 payload

    :param payload: encrypted bytes.
    :param password: encryption password.
    :param salt: kdf salt.
    :param nonce: aesgcm nonce.

    :return: decrypted payload dict.
    """

    key = derive_key(password, salt)
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, payload, None)
    return json.loads(plaintext.decode("utf-8"))


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

    def save_backup(
        self,
        domain: str,
        payload: bytes,
        encrypted: bool,
        salt: Optional[bytes],
        nonce: Optional[bytes],
    ) -> None:
        """保存备份

        :param domain: root domain.
        :param payload: payload bytes.
        :param encrypted: encrypted flag.
        :param salt: kdf salt.
        :param nonce: aesgcm nonce.
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
                    cur.execute(
                        "ALTER TABLE site_backups "
                        "ADD COLUMN IF NOT EXISTS payload BYTEA"
                    )
                    cur.execute(
                        "ALTER TABLE site_backups "
                        "ADD COLUMN IF NOT EXISTS encrypted BOOLEAN "
                        "DEFAULT FALSE"
                    )
                    cur.execute(
                        "ALTER TABLE site_backups "
                        "ADD COLUMN IF NOT EXISTS salt BYTEA"
                    )
                    cur.execute(
                        "ALTER TABLE site_backups "
                        "ADD COLUMN IF NOT EXISTS nonce BYTEA"
                    )
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

    def save_backup(
        self,
        domain: str,
        payload: bytes,
        encrypted: bool,
        salt: Optional[bytes],
        nonce: Optional[bytes],
    ) -> None:
        try:
            with self._connect(self._db_name) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO site_backups (domain, payload, encrypted, salt, nonce)
                        VALUES (%s, %s, %s, %s, %s) ON CONFLICT (domain)
                        DO
                        UPDATE SET
                            payload = EXCLUDED.payload,
                            encrypted = EXCLUDED.encrypted,
                            salt = EXCLUDED.salt,
                            nonce = EXCLUDED.nonce,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (
                            domain,
                            psycopg2.Binary(payload),
                            encrypted,
                            psycopg2.Binary(salt) if salt else None,
                            psycopg2.Binary(nonce) if nonce else None,
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
                        "SELECT domain, payload, encrypted, salt, nonce, updated_at "
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
            "payload": row["payload"],
            "encrypted": bool(row["encrypted"]),
            "salt": row["salt"],
            "nonce": row["nonce"],
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
                columns = {
                    row[1]
                    for row in conn.execute("PRAGMA table_info(site_backups)")
                }
                if "payload" not in columns:
                    conn.execute("ALTER TABLE site_backups ADD COLUMN payload BLOB")
                if "encrypted" not in columns:
                    conn.execute(
                        "ALTER TABLE site_backups "
                        "ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0"
                    )
                if "salt" not in columns:
                    conn.execute("ALTER TABLE site_backups ADD COLUMN salt BLOB")
                if "nonce" not in columns:
                    conn.execute("ALTER TABLE site_backups ADD COLUMN nonce BLOB")
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

    def save_backup(
        self,
        domain: str,
        payload: bytes,
        encrypted: bool,
        salt: Optional[bytes],
        nonce: Optional[bytes],
    ) -> None:
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO site_backups (domain, payload, encrypted, salt, nonce)
                    VALUES (?, ?, ?, ?, ?) ON CONFLICT(domain) DO
                    UPDATE SET
                        payload = excluded.payload,
                        encrypted = excluded.encrypted,
                        salt = excluded.salt,
                        nonce = excluded.nonce,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (
                        domain,
                        payload,
                        1 if encrypted else 0,
                        salt,
                        nonce,
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
                    "SELECT domain, payload, encrypted, salt, nonce, updated_at "
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
            "payload": row["payload"],
            "encrypted": bool(row["encrypted"]),
            "salt": row["salt"],
            "nonce": row["nonce"],
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


app = FastAPI(title="OmniSession", lifespan=lifespan)
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
async def backup_site(
    payload: BackupPayload,
    password: Optional[str] = Header(default=None, alias="X-USK-Password"),
) -> Dict[str, str]:
    """保存站点状态

    :param payload: backup payload.
    :return: result message.
    """

    payload_data = {
        "cookies": payload.cookies,
        "local_storage": payload.local_storage,
    }
    encrypted = bool(password)
    if encrypted:
        encrypted_blob = encrypt_payload(payload_data, password)
        payload_bytes = encrypted_blob["payload"]
        salt = encrypted_blob["salt"]
        nonce = encrypted_blob["nonce"]
    else:
        payload_bytes = json.dumps(payload_data).encode("utf-8")
        salt = None
        nonce = None

    try:
        storage = get_storage()
        storage.save_backup(
            payload.domain,
            payload_bytes,
            encrypted,
            salt,
            nonce,
        )
        LOGGER.info("Backup saved for %s", payload.domain)
    except Exception as exc:
        LOGGER.exception("Failed to save backup")
        raise HTTPException(status_code=500, detail="Failed to save backup") from exc

    return {"status": "ok"}


@app.get("/restore/{domain}", response_model=BackupResponse)
async def restore_site(
    domain: str,
    password: Optional[str] = Header(default=None, alias="X-USK-Password"),
) -> BackupResponse:
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

    if row.get("payload") is None:
        raise HTTPException(status_code=404, detail="Backup not found")

    payload_bytes = bytes(row["payload"])
    salt = bytes(row["salt"]) if row.get("salt") is not None else None
    nonce = bytes(row["nonce"]) if row.get("nonce") is not None else None

    if row.get("encrypted"):
        if not password:
            raise HTTPException(status_code=401, detail="Password required")
        try:
            payload_data = decrypt_payload(
                payload_bytes,
                password,
                salt or b"",
                nonce or b"",
            )
        except Exception as exc:
            raise HTTPException(status_code=401, detail="Invalid password") from exc
    else:
        payload_data = json.loads(payload_bytes.decode("utf-8"))

    return BackupResponse(
        domain=row["domain"],
        cookies=payload_data.get("cookies", []),
        local_storage=payload_data.get("local_storage", {}),
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
