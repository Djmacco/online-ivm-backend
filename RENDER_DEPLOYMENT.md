# Deploy the backend on Render

This guide deploys the NestJS API as a Render **Web Service** from this repository. The backend expects PostgreSQL (the project is already configured for Supabase PostgreSQL, and it can also use a Render PostgreSQL database).

## 1. Prepare the database and credentials

1. Create or select a production PostgreSQL database. Keep its connection strings private.
2. Back up any existing database before deploying migrations. For a new database, the included Prisma migrations create the schema. If the database already has tables but no matching Prisma migration history, stop and review/baseline the migration state before deploying; do not drop tables or mark migrations applied blindly.
3. In a local copy of `backend`, install dependencies and generate the signing keys:

   ```bash
   npm ci
   npm run keys:generate
   ```

4. Save the private entitlement key securely for Render. Put only the matching public key in the desktop build as `VITE_ENTITLEMENT_PUBLIC_KEY`. Never put the private key in the desktop app or commit it.
5. Generate two different random secrets of at least 32 characters for `JWT_SECRET` and `JWT_REFRESH_SECRET`. For example, run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` twice.

## 2. Create the Render service

1. Push the project to a Git provider connected to Render.
2. In Render, select **New → Web Service** and connect the repository.
3. Set **Root Directory** to `backend` (the folder containing this `package.json`). Render runs the build and start commands from this directory. See [Render monorepo support](https://render.com/docs/monorepo-support).
4. Select the **Node** runtime. Set **Node Version** to `20` with `NODE_VERSION=20` so the deployed runtime matches the backend Dockerfile's Node 20 runtime.
5. Use these commands:

   **Build Command**

   ```bash
   npm ci && npx prisma generate && npm run build
   ```

   **Pre-Deploy Command** (recommended when available)

   ```bash
   npm run prisma:deploy
   ```

   **Start Command**

   ```bash
   npm run start:prod
   ```

   Render runs pre-deploy commands before starting the new version; Render currently offers this setting on paid web services. On a single-instance service without a pre-deploy command, use `npm run prisma:deploy && npm run start:prod` as the Start Command so migrations run before the API starts. See [Render deploys](https://render.com/docs/deploys).

6. Set **Health Check Path** to `/health`. The endpoint checks the database as well as the API process.

Render web services must listen on `0.0.0.0` and the assigned `PORT`; this backend already does both. Do not hard-code a port in Render. See [Render web services](https://render.com/docs/web-services).

## 3. Add production environment variables

Add these in the service's **Environment** settings. Use Render's secret fields for credentials and keys. Render documents this in [Environment Variables and Secrets](https://render.com/docs/configure-environment-variables).

| Variable | Value / notes |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `20` |
| `DATABASE_URL` | PostgreSQL runtime connection string; use the provider's pooled/runtime URL if available |
| `DIRECT_URL` | Direct PostgreSQL connection for Prisma migrations; for a new Render PostgreSQL database, use its connection URL if no pooler is configured |
| `JWT_SECRET` | Unique random secret, at least 32 characters |
| `JWT_REFRESH_SECRET` | Different unique random secret, at least 32 characters |
| `ENTITLEMENT_PRIVATE_KEY` | 64-character hex private key from `npm run keys:generate` |
| `NOTCHPAY_PUBLIC_KEY` | Production Notch Pay public key |
| `NOTCHPAY_SECRET_KEY` | Production Notch Pay secret key |
| `NOTCHPAY_HASH_KEY` | Webhook signing key from Notch Pay |
| `PUBLIC_API_URL` | The final public service URL, e.g. `https://your-service.onrender.com` (no trailing slash) |
| `CORS_ORIGINS` | Desktop origins, comma-separated: `tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420` |
| `PREMIUM_PRICE_XAF` | `3900`; keep equal to the desktop's displayed price |
| `PREMIUM_PERIOD_DAYS` | `30` |
| `RESTORE_WINDOW_DAYS` | Optional; defaults to `7` |
| `RESTORE_MAX_DEVICES` | Optional; defaults to `3` |
| `AI_PROVIDER` | `gemini` or `anthropic` |
| `AI_API_KEY` | Secret key for the selected AI provider |
| `AI_MODEL` | Optional provider model name; use the model configured for your provider |
| `PAYMENT_CUSTOMER_EMAIL` | Optional Notch Pay customer email where required by the account/configuration |

`PORT` is supplied by Render. Do not set a different port unless you intentionally configure the service to use it. `DIRECT_URL` and `ENTITLEMENT_PRIVATE_KEY` are required in production by this backend's configuration validation.

## 4. Configure Notch Pay

In the Notch Pay dashboard, configure the webhook URL as:

```text
https://your-service.onrender.com/payments/notchpay/webhook
```

Use the matching production public key, secret key, and webhook hash key in Render. The backend verifies the webhook signature and re-checks each transaction with Notch Pay before granting Premium. A browser callback is not proof of payment.

## 5. Deploy and verify

1. Create the service. Watch the build and deploy logs. The migration step must complete before the NestJS server starts.
2. Open `https://your-service.onrender.com/health`. A healthy response looks like:

   ```json
   { "status": "ok", "time": "..." }
   ```

   A non-200 response means the service cannot reach PostgreSQL or has not started correctly; check the Render logs and database URLs.
3. From the desktop or an API client, confirm `GET /health`, `GET /subscriptions/public-key`, account registration/login, and `GET /subscriptions/status` work over HTTPS.
4. Configure the desktop cloud API URL to the Render URL and its entitlement public key to the public half paired with `ENTITLEMENT_PRIVATE_KEY`.
5. Run a Notch Pay sandbox payment first. Confirm the payment is verified server-side and the desktop accepts the resulting entitlement before switching to live credentials.

## Operational notes

- Keep the Render database and service in the same region where possible to reduce database latency.
- Do not enable multiple app instances that independently run Prisma migrations at startup. Use Render's pre-deploy command for migrations when available.
- Take database backups before schema changes and confirm the provider's backup retention policy.
- Avoid adding `SWAGGER=true` in production unless public Swagger documentation is intentionally required; Swagger is otherwise disabled in production.
- Free Render services may sleep or have plan limits that make them unsuitable for a production API that must respond reliably to desktop sync and payment callbacks. Check the current [Render web service plan details](https://render.com/docs/web-services) before choosing a plan.
