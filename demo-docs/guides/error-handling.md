# Error Handling

The API uses standard HTTP status codes and returns structured error responses.

## Error Response Format

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "The amount must be a positive integer",
    "code": "amount_invalid",
    "param": "amount"
  }
}
```

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request — invalid parameters |
| 401 | Unauthorized — invalid or missing API key |
| 403 | Forbidden — insufficient permissions |
| 404 | Not Found — resource doesn't exist |
| 409 | Conflict — idempotency conflict |
| 422 | Unprocessable Entity — validation failed |
| 429 | Too Many Requests — rate limit exceeded |
| 500 | Internal Server Error — something went wrong on our end |

## Error Types

- `invalid_request_error` — The request was malformed or missing required parameters.
- `authentication_error` — The API key is invalid, expired, or missing.
- `permission_error` — The API key doesn't have permission for this operation.
- `not_found_error` — The requested resource doesn't exist.
- `rate_limit_error` — Too many requests. Respect the `Retry-After` header.
- `api_error` — Something went wrong on our side. Contact support if this persists.

## Idempotency

All POST requests accept an `Idempotency-Key` header. If you send the same key within 24 hours, you get the same response without creating a duplicate:

```typescript
const tx = await client.transactions.create(
  { amount: 1000, currency: "USD" },
  { idempotencyKey: "order_12345" }
);
```

## Rate Limits

- Test mode: 100 requests/second
- Live mode: 1,000 requests/second
- Burst: Up to 2x the limit for 10 seconds

When rate limited, the response includes:
- `Retry-After` header (seconds until you can retry)
- `X-RateLimit-Remaining` header (requests remaining in window)
