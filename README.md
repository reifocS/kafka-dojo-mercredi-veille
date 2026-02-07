# Kafka Dojo — Food Ordering Demo

A food ordering system where customers place orders (think Uber Eats or Deliveroo behind the scenes). When an order comes in, multiple things need to happen at once: the customer gets a notification, fraud detection runs in real-time, and an audit trail is recorded. Instead of one monolith doing all of this sequentially, each concern is its own service communicating through Kafka events.

This is a workshop demo — no real database, no real payments — but the architecture mirrors how production event-driven systems work.

## Architecture

```mermaid
graph TD
    Browser -->|REST + SSE| Order[Order Service]

    Order -->|produce| orders[(orders)]
    Order -->|produce| audit[(audit)]

    orders --> Notif[Notification x2]
    orders --> Fraud[Fraud Detection]

    Notif -->|retry| orders
    Notif -->|max retries| dlq[(orders-dlq)]
    Notif --> audit
    Fraud --> audit

    audit --> Audit[Audit Service]
```

## With Kafka — Asynchronous Events

```mermaid
graph TD
    Browser -->|REST + SSE| Order[Order Service]
    Order --> OrderDB[(Order DB)]

    Order -->|produce| Kafka{{Kafka}}

    Kafka --> Notif[Notification x2]
    Kafka --> Fraud[Fraud Detection]
    Kafka --> Audit[Audit Service]

    Fraud -->|in-memory state| FraudState[(Sliding Window)]
    Audit --> AuditDB[(Audit DB)]
```

**Key difference:** Order Service just writes to its DB and publishes an event. It doesn't know or care who consumes it.

**Benefits:**
- **Loose coupling** — Order Service just produces events, doesn't know who consumes
- **Fault tolerance** — if Notification is down, messages wait in the topic
- **Parallelism** — consumers process in parallel across partitions
- **Easy scaling** — add consumers without changing producer code
- **Built-in retry** — re-produce to topic with retry header, DLQ after max attempts
- **Fraud at scale** — sliding window state in memory, fed by stream (no DB polling)

## Without Kafka — The Honest Version

For a small-to-medium system, you don't need Kafka. A well-designed monolith works fine:

```mermaid
graph TD
    Browser -->|REST| Order[Order Service]

    Order -->|1. check| DB[(Database)]
    Order -->|2. insert order| DB
    Order -->|3. insert audit| DB
    Order -->|4. enqueue| Queue[Job Queue<br/>Redis / pg-boss]

    Queue -->|async| Worker[Notification Worker]
    Worker -->|retry built-in| Queue
```

**This works well because:**
- Fraud check is **synchronous** — actually blocks bad orders
- Notification is **async** via job queue — doesn't slow down the order
- Audit is just a DB table — no separate service needed
- Simple retry via job queue (Redis, pg-boss, Sidekiq, etc.)

**Where it breaks down (and Kafka helps):**

| Scale | Problem | Kafka solution |
|-------|---------|----------------|
| ~100 orders/sec | DB fraud query becomes bottleneck | In-memory stream state |
| Multiple teams | Everyone touches the monolith | Independent consumers |
| New requirements | "Add ML fraud model" = redeploy Order Service | Just add a consumer |
| Debugging | "What happened to order X?" = query multiple tables | Replay events |
| Burst traffic | Job queue + DB can't keep up | Partitioned parallelism |

**TL;DR:** Kafka isn't about making simple things possible — it's about making complex things manageable at scale.

## Without Kafka — Microservices over REST

When you outgrow the monolith but don't have Kafka:

```mermaid
graph TD
    Browser -->|REST| Order[Order Service]

    Order -->|POST /check| Fraud[Fraud Service]
    Fraud -->|query recent orders| FraudDB[(Fraud DB)]

    Order -->|POST /notify async| Notif[Notification Service]
    Notif -->|retries| NotifQueue[(Internal Queue)]

    Order -->|POST /audit| Audit[Audit Service]
    Audit --> AuditDB[(Audit DB)]

    Notif -->|POST /audit| Audit
    Fraud -->|POST /audit| Audit

    Order --> OrderDB[(Order DB)]
```

**Trade-offs:**
- **Service discovery** — Order Service needs to know where Fraud, Notification, Audit live
- **Failure handling** — What if Fraud Service is down? Block orders? Skip check? Circuit breaker?
- **Distributed transactions** — Order created but audit failed — now what?
- **Fan-out complexity** — Adding a new consumer = change Order Service + redeploy
- **Data duplication** — Each service may need order data, so you end up copying it around

**The coordination tax:**
```
Order created → call Fraud → call Notification → call Audit
                   ↓              ↓                  ↓
              Fraud calls    Notif calls        (done)
                Audit          Audit
```

Every arrow is a potential failure point, retry logic, and latency added to the request.

## Event Shapes

### `orders` topic

Produced by Order Service on every create, update, or delete.

```json
{
  "action": "created | updated | deleted",
  "order": {
    "id": "uuid",
    "customerName": "Alice",
    "item": "Pizza",
    "quantity": 2,
    "price": 12.99,
    "status": "created",
    "createdAt": "2026-02-05T13:11:17.406Z"
  },
  "timestamp": "2026-02-05T13:11:17.406Z"
}
```

**Headers:** `retryCount` (added by Notification Service on retry, starts at `"1"`)

### `audit` topic

Produced by every service. Shape varies by source:

**From Order Service:**
```json
{
  "source": "order-service",
  "action": "created | updated | deleted",
  "orderId": "uuid",
  "order": { },
  "timestamp": "..."
}
```

**From Notification Service:**
```json
{
  "source": "notification-service",
  "action": "NOTIFIED | RETRY | DLQ",
  "orderId": "uuid",
  "instanceId": "notification-1",
  "retryCount": 2,
  "timestamp": "..."
}
```

**From Fraud Detection Service:**
```json
{
  "source": "fraud-service",
  "action": "FRAUD_ALERT | FRAUD_CHECK_PASSED",
  "orderId": "uuid",
  "customerName": "Alice",
  "alerts": [
    { "type": "VELOCITY", "reason": "Alice placed 6 orders in 1 minute", "severity": "HIGH" },
    { "type": "BURST", "reason": "25 orders in 1 minute globally", "severity": "MEDIUM" },
    { "type": "AMOUNT", "reason": "Order total $150.00 exceeds threshold", "severity": "LOW" }
  ],
  "windowStats": {
    "customerOrdersInWindow": 6,
    "globalOrdersInWindow": 25
  },
  "timestamp": "..."
}
```

### `orders-dlq` topic

Produced by Notification Service after 3 failed retries.

```json
{
  "action": "created",
  "order": { },
  "reason": "Max retries exceeded",
  "instanceId": "notification-2",
  "timestamp": "..."
}
```

### `order-status` topic (compacted)

A **log-compacted** topic that retains only the latest status per order. Kafka periodically removes older records with the same key, keeping only the most recent.

```json
{
  "id": "uuid",
  "customerName": "Alice",
  "item": "Pizza",
  "status": "created",
  "updatedAt": "..."
}
```

**Tombstones:** When an order is deleted, a `null` value is published. Compaction eventually removes the key entirely.

**Demo:** Check Kafka UI → `order-status` topic. Create/update/delete orders, then observe how only the latest state per order remains.

## Quick Start

```bash
docker compose up --build
```

- **Dashboard:** http://localhost:3001
- **Kafka UI:** http://localhost:8080

## Demo: Replay Events

Kafka retains messages — unlike SQS/RabbitMQ, you can replay them to rebuild state.

```bash
# Run fraud service in replay mode (fresh consumer group, reads from beginning)
docker compose run --rm -e REPLAY=true fraud-service
```

Watch the logs — it processes ALL historical orders and rebuilds its sliding window state from scratch.

**Why this matters:** Service crashed? Deploy a bug fix, replay events, state is restored. Traditional queues can't do this.

## Demo: Log Compaction

The `order-status` topic uses `cleanup.policy=compact`. Only the latest value per key is retained.

```bash
# Create several orders, update them, delete some
# Then check the topic in Kafka UI — only current state remains

# View compacted topic contents
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic order-status \
  --from-beginning \
  --property print.key=true
```

**Why this matters:** New service starts up → reads compacted topic → knows current state of all orders without querying a database.
