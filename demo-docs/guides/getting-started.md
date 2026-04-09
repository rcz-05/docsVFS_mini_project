# Getting Started

Welcome to the platform! This guide walks you through setup and your first API call.

## Prerequisites

- Node.js 20 or later
- An API key (get one from the dashboard at https://app.example.com/settings/api-keys)
- Basic familiarity with REST APIs

## Installation

```bash
npm install @example/sdk
```

## Quick Start

```typescript
import { Client } from "@example/sdk";

const client = new Client({
  apiKey: process.env.EXAMPLE_API_KEY,
});

// Create your first transaction
const tx = await client.transactions.create({
  amount: 1000, // in cents
  currency: "USD",
  description: "Test payment",
});

console.log(`Transaction created: ${tx.id}`);
```

## Authentication

All API requests require an API key passed in the `Authorization` header:

```
Authorization: Bearer your_api_key_here
```

Keys have two types:
- **Test keys** start with `sk_test_` — use these during development
- **Live keys** start with `sk_live_` — use these in production

## Next Steps

- Read the [API Reference](/api-reference/overview.md) for full endpoint docs
- Check out [Webhooks](/guides/webhooks.md) to get real-time notifications
- See [Error Handling](/guides/error-handling.md) for best practices
