# System Architecture Overview

## High-Level Architecture

The platform is built as a set of microservices communicating via event-driven messaging.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  API Gateway │────▶│  Transaction │────▶│  Payment        │
│  (Kong)      │     │  Service     │     │  Processor      │
└─────────────┘     └──────────────┘     └─────────────────┘
       │                    │                      │
       │                    ▼                      ▼
       │            ┌──────────────┐     ┌─────────────────┐
       │            │  PostgreSQL  │     │  Event Bus      │
       │            │  (Primary)   │     │  (Kafka)        │
       └──────────▶ └──────────────┘     └─────────────────┘
                                                  │
                           ┌──────────────────────┤
                           ▼                      ▼
                    ┌──────────────┐     ┌─────────────────┐
                    │  Webhook     │     │  Analytics       │
                    │  Service     │     │  Service         │
                    └──────────────┘     └─────────────────┘
```

## Core Services

### API Gateway
- Kong-based API gateway handling authentication, rate limiting, and routing
- Terminates TLS, validates API keys, enforces rate limits
- Routes requests to appropriate microservices

### Transaction Service
- Core business logic for payment processing
- Handles transaction creation, capture, void, and refund workflows
- Maintains transaction state machine with strict status transitions
- Uses PostgreSQL for ACID-compliant storage

### Payment Processor
- Integrates with external payment networks (Visa, Mastercard, ACH)
- Implements circuit breaker pattern for external API resilience
- Handles retry logic with exponential backoff for transient failures

### Webhook Service
- Reliable webhook delivery with at-least-once guarantees
- Consumes events from Kafka and delivers HTTP notifications
- Implements signature verification using HMAC-SHA256
- Exponential backoff retry policy (5 attempts over 24 hours)

### Analytics Service
- Real-time transaction analytics and reporting
- Powered by ClickHouse for fast aggregation queries
- Consumes events from Kafka for near-real-time dashboards

## Data Flow

1. Client sends API request → API Gateway validates auth + rate limits
2. API Gateway routes to Transaction Service
3. Transaction Service validates request, creates record in PostgreSQL
4. Transaction Service publishes event to Kafka
5. Payment Processor consumes event, calls external payment network
6. Payment Processor publishes result event to Kafka
7. Transaction Service updates status based on result
8. Webhook Service delivers notification to customer's endpoint
9. Analytics Service updates dashboards

## Infrastructure

- **Cloud**: AWS (us-east-1 primary, eu-west-1 DR)
- **Orchestration**: Kubernetes (EKS)
- **Database**: PostgreSQL 16 (RDS Multi-AZ)
- **Message Broker**: Apache Kafka (MSK)
- **Cache**: Redis Cluster (ElastiCache)
- **CDN**: CloudFront
- **Monitoring**: Datadog + PagerDuty
- **CI/CD**: GitHub Actions → ArgoCD
