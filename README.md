# Souk El Khodar API

Separate Node.js 24 / Express 5 / PostgreSQL backend starter. This project currently provides the database schema and `GET /v1/health`; storefront and admin business routes are future phases. It does not replace either portal's mock API yet.

## Local setup

1. Run `npm.cmd install` and copy `.env.example` to `.env`. Keep real credentials in `.env`.
2. Check whether a PostgreSQL server is already running. If using the included database, run `docker compose up -d postgres`. Compose maps PostgreSQL to loopback port 5433 to reduce conflicts with a native server on 5432. Set `POSTGRES_PASSWORD` in your shell before first startup and match `.env`.
3. Run `npm.cmd run migrate`, then `npm.cmd run dev`.
4. Request `http://localhost:4300/v1/health`. A healthy database returns `{ "data": { "status": "ok", "database": "ok" } }`; an unavailable database returns HTTP 503.

Migrations run in filename order, use a PostgreSQL advisory lock, and record each successful file in `schema_migrations`. Re-running them is safe. Use a distinct database and credentials for staging and production. No admin account or public seed data is created by migrations.

The implementation brief lives in `../Souk-Elخodar/docs/backend/README.md`. Route contracts still need reconciliation with both Angular clients before the frontend cutover.
