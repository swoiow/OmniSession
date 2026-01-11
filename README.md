# OmniSession

Backup and restore login state (cookies + localStorage) across subdomains via a Chrome extension and a FastAPI backend.

## Structure

- `server/` FastAPI backend
- `extension/` Chrome extension (Manifest V3)

## Backend setup

1. Create the database table:

```sql
CREATE TABLE site_backups
(
    id         SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    domain  TEXT NOT NULL,
    device  TEXT,
    payload    BYTEA       NOT NULL,
    encrypted  BOOLEAN     NOT NULL DEFAULT FALSE,
    salt       BYTEA,
    nonce      BYTEA,
    updated_at TIMESTAMP            DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX site_backups_user_domain_idx
    ON site_backups (user_id, domain);
```

2. Install deps:

```bash
cd server
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
```

3. Configure environment variables (see `server/.env.example`).
  - If PostgreSQL is unavailable, the backend automatically falls back to SQLite using `USK_SQLITE_PATH`.

4. Run the API (database + schema are auto-initialized on startup, or call `POST /init`):

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Docker (backend)

Use the unified Docker script:

```bash
bash docker.sh build
bash docker.sh start
bash docker.sh logs
```

## Extension setup

1. Open `chrome://extensions` and enable Developer Mode.
2. Click "Load unpacked" and select the `extension/` directory.
3. Open extension settings and configure the backend base URL (default is `http://localhost:8000`).

- Set your email address in settings to generate a user ID.
- Optional: set an encryption password; backups are end-to-end encrypted before upload.

## Usage

- Open a site and click Backup.
- Navigate to another subdomain and click Restore.

Notes:

- localStorage is captured per-origin in a single backup record. The extension uses cookie domains to discover candidate
  subdomains and opens background tabs to collect/restore storage where possible.

## Data flow

Backup flow:

1. Read the current tab URL and compute the root domain (e.g. `login.baidu.com` -> `baidu.com`).
2. Fetch cookies for the root domain (`chrome.cookies.getAll({ domain })`), which includes subdomain cookies.
3. Read localStorage for the current origin.
4. Use cookie `domain` values to build a candidate host list, then open background tabs per host to read localStorage.
5. Send `{ domain, cookies, local_storage }` to the backend, where `local_storage` is an origin map.
   The payload includes `user_id` (derived from email). If a password is configured, the extension uses
   `/e2e/backup` and uploads an encrypted payload instead of plaintext.

Restore flow:

1. Read the current tab URL and compute the root domain.
2. Fetch backup from the backend with `X-USK-User`. When a password is configured, the extension uses
   `/e2e/restore` and decrypts the payload locally.
3. Restore each cookie using its original `domain`, `path`, `secure`, `httpOnly`, and `sameSite` values.
4. Write localStorage for the current origin immediately, then open background tabs for other origins in the map and
   restore each.
5. Reload the current tab after restores complete.

## Q&A

Q: If a site has cookies `name=a`, `name=b`, `name=c`, will repeated backups store `(a,b,c)*n`?
A: No. Each backup overwrites the entire record for the root domain. The backend replaces the `cookies` JSON with the
latest payload.

Q: Can cookies have duplicate keys?
A: Cookies can share the same `name` if their `domain` or `path` differs. The effective unique key is
`(name, domain, path)`. The extension merges cookies by that key before upload.

Q: Is cookie merging handled by Python or the database?
A: The extension merges cookies in `extension/background.js` before upload. The backend stores the merged list as-is and
does not do per-cookie merging.

Q: Will a `Domain=.v2ex.com` cookie be restored?
A: Yes. The restore uses the cookie's original `domain` value. Cookies with `domain=.v2ex.com` are set back with that
same domain, and they apply to subdomains as expected.

Q: How is encryption handled?
A: When a password is set, the extension uses AES-GCM with a PBKDF2-derived key to encrypt the payload locally and
uploads it through `/e2e/`. The backend stores encrypted payloads without decrypting them. Without a password, payloads
are stored in plaintext. You must use the same password to restore.
