# Production Roadmap (Priority-Ordered)

This is a production-hardening plan with concrete file changes and API adjustments.

## P0 — Security & Data Protection (must-have before public use)

1) Enforce authentication and authorization

- Change: Require an API key or bearer token for all non-root endpoints.
- Files:
  - server/main.py: add dependency to verify `Authorization: Bearer <token>`.
  - server/.env.example: add `USK_API_TOKEN`.
  - extension/background.js: send `Authorization` header in all requests.
  - extension/options.html / extension/options.js: add a field to store token.
  - README.md: document auth setup.
- API: All endpoints require Authorization header; respond 401 otherwise.

2) TLS-only transport (no plaintext passwords or tokens)

- Change: Block `http://` API base in the extension unless explicitly allowed.
- Files:
  - extension/options.js: validate API base; warn on `http://`.
  - extension/i18n.js: add warning strings.
  - README.md: recommend HTTPS and reverse proxy.
- API: No change, but extension blocks insecure base by default.

3) Move encryption to the client (zero-knowledge server)

- Change: The extension encrypts payloads with WebCrypto; server stores ciphertext only.
- Files:
  - extension/background.js: AES-GCM encrypt/decrypt using a user password.
  - server/main.py: treat payload as opaque bytes (no password header).
  - server/schema migration: keep `payload`, `salt`, `nonce`, `encrypted`.
  - README.md: update encryption flow.
- API: `/backup` and `/restore/{domain}` stay, but no password header; payload is encrypted blob.

4) Restrict CORS and local exposure

- Change: Allow only your extension origin (and optionally a UI domain).
- Files:
  - server/main.py: replace `allow_origins=["*"]` with configured list.
  - server/.env.example: add `USK_ALLOWED_ORIGINS`.
- API: No change.

## P1 — Correctness & Compatibility

5) Public Suffix List for root domain detection

- Change: Replace naive split logic with PSL-based library.
- Files:
  - extension/background.js: use PSL (e.g., `tldts` or `psl`)
  - extension/manifest.json: include bundled dependency.
  - README.md: document PSL behavior.
- API: No change.

6) Partitioned cookies support (CHIPS)

- Change: Persist and restore `partitionKey` if present.
- Files:
  - extension/background.js: include `partitionKey` when saving, pass to `chrome.cookies.set` on restore.
  - README.md: mention CHIPS support.
- API: No change.

7) Payload size limits and rate limiting

- Change: Cap payload size and request rate per token.
- Files:
  - server/main.py: add max JSON size checks; add simple rate limiter.
  - README.md: document limits.
- API: On violation return 413 or 429.

## P2 — Product UX & Reliability

8) User/profile scoping

- Change: Make backups multi-tenant (profile or user id).
- Files:
  - server/main.py: add `profile_id` column and require it.
  - server/schema migration: add `profile_id TEXT NOT NULL` and unique index `(profile_id, domain)`.
  - extension/options.js: add profile id input.
  - extension/background.js: include profile id in requests.
  - README.md: document scoping rules.
- API: `POST /backup` and `GET /restore/{domain}` require `X-USK-Profile` header or `/restore/{profile}/{domain}`.

9) Better error taxonomy and telemetry

- Change: Consistent error codes for UI; optional health/metrics endpoint.
- Files:
  - server/main.py: standard error response format.
  - extension/popup.js: display errors by code.
- API: Add `/metrics` or `/health` with more detail.

10) Background job for cleanup/retention

- Change: Auto-delete old backups by policy.
- Files:
  - server/main.py: scheduled cleanup on startup or background task.
  - server/.env.example: `USK_RETENTION_DAYS`.
- API: Optional `DELETE /backup/{domain}` already exists; add `DELETE /backup` (all for profile) if needed.

## P3 — Operations & Maintainability

11) Database migrations

- Change: Introduce Alembic for schema changes.
- Files:
  - server/alembic/*, server/alembic.ini
  - server/main.py: run migrations on startup.

12) CI + security scanning

- Change: Add lint, unit tests, dependency audit.
- Files:
  - .github/workflows/*.yml: add lint/test jobs.
  - server/tests/*: storage and crypto tests.

13) Observability & logging hygiene

- Change: Remove sensitive data from logs, add structured logging.
- Files:
  - server/main.py: sanitize logs; add request id.
  - README.md: logging policy.

14) Packaging and release hardening

- Change: Signed builds for extension and server artifacts.
- Files:
  - .github/workflows/build.yml: add signing steps.
  - README.md: release verification.
