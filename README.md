# StockFlow AI – Cloud Backend (NestJS + Supabase)

The online half of the system. The Tauri desktop app stays offline-first (SQLite is its source of truth). This service
provides: **cloud accounts, versioned two-way sync (Premium), Notch Pay subscriptions, signed offline entitlements,
and the AI store-scan proxy**. It implements the contract in the desktop repo: `docs/BACKEND_CONTRACT.md`.

```
Tauri desktop (SQLite) ──HTTPS──▶ NestJS ──▶ Supabase PostgreSQL (RLS on, never accessed directly)
```

## Quick start
For the full production deployment procedure, including Render configuration, environment variables and database migration steps, see [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md).

```bash
cp .env.example .env            # fill in
npm install
npm run keys:generate           # prints ENTITLEMENT_PRIVATE_KEY (backend) + VITE_ENTITLEMENT_PUBLIC_KEY (desktop)
npm run prisma:deploy
# Supabase SQL editor: run prisma/rls.sql once
npm run start:dev               # http://localhost:3000  (Swagger: /docs in dev)
npm test                        # 119 tests, no database needed
```
Docker: `docker build -t ims-backend . && docker run --env-file .env -p 3000:3000 ims-backend`

## Endpoints (exactly what the desktop calls)
| | Auth | |
|---|---|---|
| `POST /auth/register` `{email,password,fullName,deviceId,deviceName}` | public | → `{accessToken,refreshToken,…}` |
| `POST /auth/login` | public | |
| `POST /auth/refresh` `{refreshToken,deviceId}` | public | rotates the refresh token; reuse of an old one kills the family |
| `POST /payments/notchpay/create` `{plan:'PREMIUM',provider:'MTN_MOMO'\|'ORANGE_MONEY',phone,deviceId}` | **public**, rate-limited | → `{reference,status:'PENDING',deviceToken?}` (PIN prompt on the phone) |
| `POST /payments/notchpay/webhook` | signature-checked, never trusted | re-verifies with Notch Pay |
| `GET /subscriptions/status?deviceId=&reference=` | reference **or** device token **or** JWT | → `{status,entitlement?,expiresAt?}` |
| `GET /subscriptions/trial` | account JWT | current shop trial eligibility and status |
| `POST /subscriptions/trial/sync` | account JWT + subscription.manage | starts the shop's one 30-minute cloud sync window |
| `POST /subscriptions/share` / `DELETE /subscriptions/share/:deviceId` | paying device token or account JWT | share/remove Premium with up to nine shop PCs |
| `POST /sync/push` `{deviceId,changes[]}` | account JWT + **Premium on that device** | `ACCEPTED/DUPLICATE/CONFLICT/REJECTED` |
| `GET /sync/pull?since=&deviceId=&limit=` | account JWT + Premium | `{records,nextCursor,hasMore}` |
| `GET /sync/restore?deviceId=&after=&limit=` | account JWT, **no Premium needed** (time-boxed) | snapshot of the current state for a replacement PC: `{records,next,hasMore,snapshotCursor}` |
| `POST /ai/store-scan` `{image,mime,lang}` | JWT **or** device token + Premium | → `{detections}` |
| `POST /ai/execute` | JWT | optional cloud LLM proxy (free); provider-neutral blocks |
| `GET /subscriptions/public-key`, `GET /health` | public | |
| `/users`, `/devices`, `/audit`, `/auth/me`, `/auth/change-password` … | JWT + RBAC | account management |

Premium missing → `402 {"code":"PREMIUM_REQUIRED"}` (the desktop maps this to "Premium required", local data untouched).

## How it behaves
* **Premium is per DEVICE** (the customer pays from the app without an account). Enforced server-side on sync and scan. A subscribed main PC can share Premium with up to nine paired shop PCs.
* **One introductory trial per shop and main PC**: one 30-minute cloud sync window and one successful AI shelf scan. The claim is stored in the database, so a new account or reinstall on the same PC cannot reset it. A failed scan releases its claim; successful scans consume it. Restore remains free under its separate recovery limits.
* **Price is decided by the server** (`PREMIUM_PRICE_XAF`, default **3900** to match the desktop). Keep it equal to `PREMIUM_PRICE_XAF`
  in `desktop/src/entitlement/entitlement.ts` – the user must be charged what the app displays.
* **Entitlement** = `base64url(JSON).base64url(Ed25519 signature)`, raw-hex keys, byte-compatible with the desktop verifier
  (tested both directions with `@noble/curves`). Valid offline until `expiresAt`; bound to the device; clock-rollback detectable.
* **Payments**: every outcome is re-fetched from Notch Pay with the secret key (status, amount, currency, reference) before
  Premium is granted; activation is an atomic claim, so webhook replays/polling races cannot double-credit. Renewals stack.
* **Sync** = versioned store. `baseVersion == current` → `ACCEPTED` (`version+1`); otherwise `CONFLICT` + server copy and the desktop
  resolves (`desktop/src/sync/conflict.ts`). Replays by `opId` → `DUPLICATE`. Immutable ledgers (`stock_movements, sale_items,
  customer_payments, supplier_payments, purchase_items, audit_log`) are never overwritten. **Completed sales can't be rewritten**
  (only cancelled). One writer per business at a time, so the cursor can never skip a change. A failing request is replayed safely.
* **AI provider = Gemini by default** (`AI_PROVIDER=gemini|anthropic`, `AI_API_KEY`, `AI_MODEL`). The key is sent in the
  `x-goog-api-key` header (never in a URL) and stays on the server. Store scan uses JSON mode at temperature 0; the optional
  `/ai/execute` proxy translates tool calls both ways. A rejected key or wrong model name answers **503**, never 401/402/403
  (your desktop would read those as "session expired" / "Premium required"). Quota → 429, safety refusal → 422.
  Privacy: on Google's free tier, submitted content may be used to improve their products; use a billing-enabled key for customers'
  shelf photos and check Google's current terms.
* **Free restore (new computer after a crash).** `GET /sync/restore` returns the *current* state of every record (not the history),
  parents before children, in pages. A device with Premium may always call it; any other device of a business that has data may for
  `RESTORE_WINDOW_DAYS` (7) from its first call, and a business can restore at most `RESTORE_MAX_DEVICES` (3) such devices per 30 days,
  so it is a recovery tool, not a free mirror. It is read-only (uploading still needs Premium). Every page carries the same
  `snapshotCursor`; the desktop stores it as its sync cursor and a later Premium sync continues from there. Nothing is lost or re-downloaded.
* **Staff accounts, roles and shop settings** (`users`, `roles`, `role_permissions`, `app_settings`) can be synchronised, administrators
  only: they are rejected on push and hidden from pull/restore for any account without `users.manage` / `settings.manage`. Users must carry a
  proper salted PBKDF2 hash (64 hex, ≥100k iterations) and never a plaintext password; lock-out counters stay local; only an allow-list of
  shop-level settings is accepted, so secrets and per-device state (cloud session, entitlement, recovery key, sync cursor…) can never reach the cloud.
* **Security**: bcrypt, short JWT + rotating refresh, lockout, rate limits, DTO whitelist validation, RBAC, tenant isolation,
  device revocation, audit log with redaction, helmet, CORS allow-list (Tauri origins), RLS + append-only triggers, no secret in the app.

## Verification
* `npm test -- --runInBand` – 119 tests: entitlement interop, RBAC, sync contract, payments, and a full app boot of the HTTP security chain.
* Desktop side: `BACKEND_DIR=../backend npm test -- backendIntegration` runs **the desktop's real SyncEngine/CloudClient against this
  backend over HTTP** (premium gating, certificate install, two devices converging, offline double-selling, conflicts, cancellations,
  Premium lapse/renewal) – 7/7 passing. The database is an in-memory fake: **not yet run against real Supabase or live Notch Pay.**

## Before shipping
1. `npx prisma generate && npm run prisma:deploy && npm run build`.
2. Run `prisma/rls.sql` in Supabase.
3. Run a Notch Pay **sandbox** payment end to end. Confirm channel codes `cm.mtn` / `cm.orange`, webhook payload shape, and that the secret
   key may call `GET /payments/{ref}`. Set `PAYMENT_CUSTOMER_EMAIL` (Notch Pay wants an e-mail; devices have none).
4. Wire an e-mail provider in `auth/mail.service.ts` (password reset logs the token in development only).

## Not included (vs. the first version)
The generic REST resources (`/products`, `/sales`, `/inventory/adjust`) and `/reports/*` were removed: the desktop contract syncs snake_case
tables with its own conflict policy, so they'll be rebuilt for web/mobile against that schema. See `docs/DESKTOP_SETUP.md` for wiring the app.
