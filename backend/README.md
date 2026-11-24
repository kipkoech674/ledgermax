# LedgerLens API

FastAPI and PostgreSQL MVP for invoices, imported transactions, suggested matches, and payment reconciliation.

## Start locally

From the project root, run `docker compose up`. The dashboard is served at `http://localhost:8000`, the API at `http://localhost:8001`, and interactive endpoint docs at `http://localhost:8001/docs`. The API applies Alembic migrations before starting. The browser dashboard checks the API and uses the sample-only demo interface if the API is unavailable. With the local Compose setting, the first account registered claims the pre-created workspace, including migrated or seeded records.

To load sample records, in another terminal run:

```sh
docker compose exec api python seed.py
```

The sample loader only inserts records when there are no invoices yet. The API container applies Alembic migrations before starting.

## Endpoints

- `GET /api/health`
- `POST /api/auth/register` (creates a workspace owner; password must be at least 12 characters)
- `POST /api/auth/login` (OAuth2 password form, returns a one-hour bearer token)
- `GET /api/auth/me`
- `POST /api/auth/change-password` (authenticated; requires the current password)
- `PATCH /api/workspace` (authenticated workspace owner; writes an audit event)
- `GET /api/dashboard` (authenticated)
- `GET, POST /api/invoices` (authenticated; writes require owner or accountant)
- `POST /api/invoices/extract` (PDF or image to reviewed invoice fields; requires `OPENAI_API_KEY`)
- `GET, POST /api/transactions` (authenticated; writes require owner or accountant)
- `GET /api/transactions/{id}/candidates` (ranked open-invoice options for payment review)
- `POST /api/transactions/import` (CSV/TXT multipart upload; owner or accountant)
- `POST /api/matches` (confirm a full or partial payment match; owner or accountant)
- `GET /api/audit` (workspace events; authenticated)

Invoice and transaction amounts use decimal KES values. A transaction can be split across invoices and an invoice can be paid by several transactions. Unique invoice numbers and statement references protect against accidental duplicate imports. Invoice creation, manual transaction creation, statement imports, and confirmed matches write an audit event in the same database transaction as the financial change. Audit events are append-only through this API.

Passwords are hashed with Argon2 and API access uses signed JWT bearer tokens, following [FastAPI's current OAuth2/JWT guidance](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/). Invoice, transaction, match, dashboard, and audit queries are restricted to the authenticated user's workspace. The API honors `owner`, `accountant`, and `viewer` write permissions; only workspace owners are created by the current registration UI.

Set `DATABASE_URL`, `CORS_ORIGINS`, and a strong random `JWT_SECRET` for any non-local deployment. The Compose secret is only for local development. This starter does not yet include a team invitation flow, refresh tokens, rate limiting, production secrets management, or encrypted document storage; do not expose the development instance to real financial data.

For local invoice extraction, set `OPENAI_API_KEY` in a `.env` file at the project root, then rebuild the API with `docker compose up --build`. You can optionally set `OPENAI_MODEL`; it defaults to `gpt-4.1-mini`. Uploaded documents are sent to the configured model for extraction and are not saved by this endpoint. Review the returned values in the invoice form before saving.
