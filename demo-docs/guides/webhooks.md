# Webhooks

Webhooks let you receive real-time HTTP notifications when events happen in your account.

## Setting Up Webhooks

1. Go to **Dashboard → Settings → Webhooks**
2. Click **Add Endpoint**
3. Enter your HTTPS URL (e.g., `https://api.yourapp.com/webhooks`)
4. Select the events you want to receive

## Event Types

| Event | Description |
|-------|-------------|
| `transaction.created` | A new transaction was created |
| `transaction.completed` | A transaction was successfully processed |
| `transaction.failed` | A transaction failed |
| `refund.created` | A refund was initiated |
| `refund.completed` | A refund was processed |
| `account.updated` | Account settings were changed |

## Webhook Payload

Every webhook delivery includes:

```json
{
  "id": "evt_1234567890",
  "type": "transaction.completed",
  "created_at": "2026-04-01T12:00:00Z",
  "data": {
    "id": "tx_abc123",
    "amount": 5000,
    "currency": "USD",
    "status": "completed"
  }
}
```

## Verifying Signatures

Every webhook includes an `X-Signature-256` header. Verify it to ensure the webhook came from us:

```typescript
import crypto from "crypto";

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

## Retry Policy

Failed deliveries (non-2xx response) are retried with exponential backoff:
- 1st retry: 1 minute
- 2nd retry: 5 minutes
- 3rd retry: 30 minutes
- 4th retry: 2 hours
- 5th retry: 24 hours

After 5 failed attempts, the endpoint is disabled and you receive an email notification.
