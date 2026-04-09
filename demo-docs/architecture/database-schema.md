# Database Schema

## Core Tables

### transactions

The primary table storing all payment transactions.

```sql
CREATE TABLE transactions (
    id              TEXT PRIMARY KEY DEFAULT gen_txid(),
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        TEXT NOT NULL CHECK (length(currency) = 3),
    status          TEXT NOT NULL DEFAULT 'pending',
    description     TEXT,
    customer_id     TEXT REFERENCES customers(id),
    metadata        JSONB DEFAULT '{}',
    idempotency_key TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_status CHECK (
        status IN ('pending', 'completed', 'failed', 'authorized',
                   'voided', 'refunded', 'partially_refunded')
    )
);

CREATE INDEX idx_transactions_customer ON transactions(customer_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);
```

### customers

Customer profiles with optional saved payment methods.

```sql
CREATE TABLE customers (
    id          TEXT PRIMARY KEY DEFAULT gen_cusid(),
    email       TEXT NOT NULL,
    name        TEXT,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_customers_email ON customers(email);
```

### refunds

Tracks refunds issued against completed transactions.

```sql
CREATE TABLE refunds (
    id              TEXT PRIMARY KEY DEFAULT gen_refid(),
    transaction_id  TEXT NOT NULL REFERENCES transactions(id),
    amount          BIGINT NOT NULL CHECK (amount > 0),
    reason          TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_refund_status CHECK (
        status IN ('pending', 'completed', 'failed')
    )
);

CREATE INDEX idx_refunds_transaction ON refunds(transaction_id);
```

### webhook_endpoints

Customer-configured webhook endpoints for event notifications.

```sql
CREATE TABLE webhook_endpoints (
    id          TEXT PRIMARY KEY DEFAULT gen_whid(),
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    events      TEXT[] NOT NULL DEFAULT '{}',
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### webhook_deliveries

Log of all webhook delivery attempts for debugging and retry.

```sql
CREATE TABLE webhook_deliveries (
    id              TEXT PRIMARY KEY DEFAULT gen_ulid(),
    endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id),
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    response_status INTEGER,
    response_body   TEXT,
    attempt         INTEGER NOT NULL DEFAULT 1,
    next_retry_at   TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX idx_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE next_retry_at IS NOT NULL;
```

## Migrations

We use `golang-migrate` for schema migrations. All migrations are in `db/migrations/`:

```
db/migrations/
├── 001_create_customers.up.sql
├── 001_create_customers.down.sql
├── 002_create_transactions.up.sql
├── 002_create_transactions.down.sql
├── 003_create_refunds.up.sql
├── 003_create_refunds.down.sql
├── 004_create_webhooks.up.sql
└── 004_create_webhooks.down.sql
```
