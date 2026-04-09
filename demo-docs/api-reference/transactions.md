# Transactions API

## Create a Transaction

```
POST /v1/transactions
```

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | integer | Yes | Amount in cents (e.g., 1000 = $10.00) |
| `currency` | string | Yes | Three-letter ISO currency code (e.g., "USD") |
| `description` | string | No | Description for the transaction |
| `customer_id` | string | No | Associated customer ID |
| `metadata` | object | No | Key-value pairs for your own use |
| `capture` | boolean | No | Auto-capture (default: true). Set false for auth-only. |

### Example

```bash
curl -X POST https://api.example.com/v1/transactions \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 5000,
    "currency": "USD",
    "description": "Order #1234",
    "customer_id": "cus_abc123",
    "metadata": {
      "order_id": "1234"
    }
  }'
```

### Response

```json
{
  "id": "tx_1a2b3c4d",
  "object": "transaction",
  "amount": 5000,
  "currency": "USD",
  "status": "completed",
  "description": "Order #1234",
  "customer_id": "cus_abc123",
  "metadata": { "order_id": "1234" },
  "created_at": "2026-04-01T12:00:00Z",
  "updated_at": "2026-04-01T12:00:01Z"
}
```

## Retrieve a Transaction

```
GET /v1/transactions/:id
```

Returns the transaction object for the given ID.

## List Transactions

```
GET /v1/transactions
```

### Query Parameters

| Field | Type | Description |
|-------|------|-------------|
| `limit` | integer | Max results (1-100, default 25) |
| `cursor` | string | Pagination cursor |
| `status` | string | Filter by status: pending, completed, failed, voided |
| `customer_id` | string | Filter by customer |
| `created_after` | string | ISO 8601 timestamp |
| `created_before` | string | ISO 8601 timestamp |

## Transaction Statuses

- `pending` — Transaction is being processed
- `completed` — Transaction was successful
- `failed` — Transaction was declined or errored
- `authorized` — Amount is held but not captured (when capture=false)
- `voided` — Authorization was voided before capture
- `refunded` — Transaction was fully refunded
- `partially_refunded` — Transaction was partially refunded
