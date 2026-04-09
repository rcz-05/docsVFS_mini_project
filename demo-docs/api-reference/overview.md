# API Reference

Base URL: `https://api.example.com/v1`

All requests must include:
- `Authorization: Bearer <api_key>` header
- `Content-Type: application/json` for POST/PUT requests

## Resources

### Transactions
The core resource. Create, retrieve, and list payment transactions.

- `POST /v1/transactions` — Create a transaction
- `GET /v1/transactions/:id` — Retrieve a transaction
- `GET /v1/transactions` — List transactions
- `POST /v1/transactions/:id/capture` — Capture an authorized transaction
- `POST /v1/transactions/:id/void` — Void an authorized transaction

### Refunds
Issue full or partial refunds on completed transactions.

- `POST /v1/refunds` — Create a refund
- `GET /v1/refunds/:id` — Retrieve a refund
- `GET /v1/refunds` — List refunds

### Customers
Manage customer profiles and saved payment methods.

- `POST /v1/customers` — Create a customer
- `GET /v1/customers/:id` — Retrieve a customer
- `PATCH /v1/customers/:id` — Update a customer
- `DELETE /v1/customers/:id` — Delete a customer
- `GET /v1/customers` — List customers

### Webhooks
Manage webhook endpoints programmatically.

- `POST /v1/webhooks` — Create a webhook endpoint
- `GET /v1/webhooks/:id` — Retrieve a webhook endpoint
- `PATCH /v1/webhooks/:id` — Update a webhook endpoint
- `DELETE /v1/webhooks/:id` — Delete a webhook endpoint
- `GET /v1/webhooks` — List webhook endpoints

## Pagination

List endpoints return paginated results. Use `cursor` and `limit` parameters:

```
GET /v1/transactions?limit=25&cursor=tx_abc123
```

Response includes:
```json
{
  "data": [...],
  "has_more": true,
  "next_cursor": "tx_xyz789"
}
```

## Versioning

The API is versioned via the URL path (`/v1/`). Breaking changes are introduced in new major versions. Non-breaking additions (new fields, new endpoints) are added to the current version.
