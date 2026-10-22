# Souk El Khodar API

Node.js 24 / Express 5 / PostgreSQL backend for the storefront and dashboard. Public routes use `/v1`; dashboard routes use `/v1/admin`.

## Local setup

1. Run `npm.cmd install` and copy `.env.example` to `.env`. Keep real credentials in `.env`.
2. Check whether a PostgreSQL server is already running. If using the included database, run `docker compose up -d postgres`. Compose maps PostgreSQL to loopback port 5433 to reduce conflicts with a native server on 5432. Set `POSTGRES_PASSWORD` in your shell before first startup and match `.env`.
3. Run `npm.cmd run migrate`, `npm.cmd run seed`, then `npm.cmd run dev`.
4. Request `http://localhost:4300/v1/health`. A healthy database returns `{ "data": { "status": "ok", "database": "ok" } }`; an unavailable database returns HTTP 503.

5. Run `npm.cmd run check`, `npm.cmd run build`, and `npm.cmd run smoke` to verify the API and database together.

Migrations run in filename order, use a PostgreSQL advisory lock, and record each successful file in `schema_migrations`. Re-running them is safe. Use a distinct database and credentials for staging and production.

In development, `seed` creates four demo dashboard accounts: `owner@souk.local`, `operations@souk.local`, `catalog@souk.local`, and `viewer@souk.local`. They use `MOCK_ADMIN_PASSWORD` (default `DemoAdmin123!`). Seeding does not create admin accounts in staging or production. Do not point a public deployment at the development database.

For a fresh production database, migrate and seed catalog/content, then supply `ADMIN_BOOTSTRAP_EMAIL` and a strong `ADMIN_BOOTSTRAP_PASSWORD` privately and run `npm.cmd run bootstrap:owner` once. This command refuses to run after an admin user exists. Set a persistent random `TRACKING_TOKEN_SECRET` before accepting orders; changing it invalidates existing guest tracking links. OTP delivery is controlled by `OTP_MODE`; see [TWILIO-OTP.md](TWILIO-OTP.md) for the temporary WhatsApp test setup.

## Portal configuration

- Storefront: set `USE_MOCK_API=false`, `API_BASE_URL` to the public API origin plus `/v1`, and `SSR_API_BASE_URL` to the server-reachable API origin plus `/v1`.
- Dashboard: set `DASHBOARD_API_BASE_URL` to the same API origin plus `/v1`.
- Backend: set `STOREFRONT_ORIGIN` and `DASHBOARD_ORIGIN` to the exact browser origins. Trailing slashes are normalized. Set `PUBLIC_SITE_URL` for SEO canonical links.

Customer sessions use an HttpOnly cookie; admin sessions use an opaque bearer token. For a cross-site storefront/API deployment, verify cookie and SSR forwarding behavior in staging before switching the storefront. Announcement updates use WebSocket and order/catalog updates use SSE, so host the API as a long-running Node service.

## Product media

Set the backend-only `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `S3_BUCKET=products` for a public-read Neon object-storage bucket. The dashboard uploads through `POST /v1/admin/products/:id/media` (`multipart/form-data`, field `file`); it never receives storage credentials. The backend saves the generated object key and public URL in `product_media`. A product can have up to 4 images (JPEG, PNG, WebP; 8 MB each) and 2 videos (MP4, WebM; 50 MB each). The dashboard can order media, choose an image cover, and remove media. Save a new product before uploading files. Existing cover images count toward the four-image limit.

Current implementation status and known gaps are tracked in the storefront's `docs/backend/READINESS-AUDIT.md`. The API inventory is in `docs/api/openapi.yaml` and `docs/api/admin-openapi.yaml` there. Keep both portals on their mock API until staging contract checks and production service setup pass.
