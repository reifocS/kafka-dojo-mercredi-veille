# Product Specification: Kafka Dojo

> A workshop demo for event-driven food ordering architecture

---

## 1. Vision

Build a **food ordering system** (think Uber Eats / Deliveroo backend) that demonstrates how **event-driven architecture** with Kafka decouples services, enables fault tolerance, and scales horizontally.

```mermaid
mindmap
  root((Kafka Dojo))
    Workshop Goals
      Learn Kafka basics
      Understand event sourcing
      See consumer groups in action
      Experience retry & DLQ patterns
    Product Domain
      Food ordering
      Real-time notifications
      Fraud detection
      Audit trail
    Architecture Patterns
      Pub/Sub messaging
      Consumer group scaling
      Dead Letter Queue
      SSE for real-time UI
```

---

## 2. System Context

```mermaid
C4Context
    title System Context Diagram

    Person(user, "Workshop Participant", "Places orders via dashboard")

    System_Boundary(dojo, "Kafka Dojo") {
        System(order, "Order Service", "REST API + Dashboard")
        System(kafka, "Apache Kafka", "Event broker")
        System(notif, "Notification Service", "Simulates customer notifications")
        System(fraud, "Fraud Detection", "Real-time anomaly detection")
        System(audit, "Audit Service", "Logs all events")
    }

    Rel(user, order, "HTTP + SSE")
    Rel(order, kafka, "Produce/Consume")
    Rel(notif, kafka, "Consume/Produce")
    Rel(fraud, kafka, "Consume/Produce")
    Rel(audit, kafka, "Consume")
```

---

## 3. User Stories

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-1 | Workshop participant | Create/update/delete orders via a dashboard | I can see events flow through the system |
| US-2 | Workshop participant | See real-time audit logs in the UI | I understand how events propagate |
| US-3 | Workshop participant | Observe notification failures and retries | I learn the retry/DLQ pattern |
| US-4 | Workshop participant | Trigger fraud alerts by spamming orders | I understand real-time event correlation |
| US-5 | Workshop participant | Inspect Kafka topics via UI | I can debug and explore messages |

---

## 4. Functional Requirements

### 4.1 Order Management

```mermaid
flowchart LR
    subgraph "Order Service"
        API[REST API]
        UI[Dashboard]
        SSE[SSE Endpoint]
    end

    API -->|POST /orders| Create
    API -->|PUT /orders/:id| Update
    API -->|DELETE /orders/:id| Delete
    API -->|GET /orders| List

    Create & Update & Delete --> Kafka[(orders topic)]
    Create & Update & Delete --> Audit[(audit topic)]

    SSE -->|real-time| UI
```

**Acceptance Criteria:**
- Orders have: `id`, `customerName`, `item`, `quantity`, `price`, `status`, `createdAt`
- All mutations produce to `orders` and `audit` topics
- Dashboard updates in real-time via SSE

### 4.2 Notification Processing

```mermaid
stateDiagram-v2
    [*] --> Received: orders topic
    Received --> Processing

    Processing --> Success: random > FAIL_RATE
    Processing --> Failed: random < FAIL_RATE

    Success --> [*]: audit NOTIFIED

    Failed --> Retry: retryCount < 2
    Retry --> [*]: re-produce to orders

    Failed --> DLQ: retryCount >= 2
    DLQ --> [*]: produce to orders-dlq
```

**Acceptance Criteria:**
- Run 2 instances in same consumer group (partition distribution)
- Configurable `FAIL_RATE` to simulate failures (default 30%)
- Max 2 retries before sending to DLQ
- Each state transition produces audit event

### 4.3 Fraud Detection — Real-time Anomaly Detection

> **Why Kafka?** Fraud detection requires correlating events over sliding time windows.
> You can't detect "6 orders in the last minute from same customer" with a DB query
> without expensive polling. Event streams make this natural and real-time.

```mermaid
flowchart TD
    orders[(orders topic)] --> Consumer

    Consumer --> Skip{action = created?}
    Skip -->|no| Ignore
    Skip -->|yes| Analyze

    subgraph "Sliding Window State"
        CustomerWindow["Per-customer order history<br/>(last 60 seconds)"]
        GlobalWindow["Global order count<br/>(last 60 seconds)"]
    end

    Analyze --> CustomerWindow
    Analyze --> GlobalWindow

    CustomerWindow --> VelocityCheck{"> 5 orders/min?"}
    GlobalWindow --> BurstCheck{"> 20 orders/min?"}
    Analyze --> AmountCheck{"> $100 total?"}

    VelocityCheck -->|yes| Alert[FRAUD_ALERT]
    BurstCheck -->|yes| Alert
    AmountCheck -->|yes| Alert

    VelocityCheck -->|no| Pass
    BurstCheck -->|no| Pass
    AmountCheck -->|no| Pass

    Pass --> Passed[FRAUD_CHECK_PASSED]

    Alert --> audit[(audit topic)]
    Passed --> audit
```

**Acceptance Criteria:**
- **Velocity check** — flag customers placing > 5 orders/minute (HIGH severity)
- **Burst detection** — flag when > 20 orders/minute globally, potential bot attack (MEDIUM severity)
- **Amount anomaly** — flag orders > $100 total (LOW severity)
- Maintain sliding 60-second windows per customer AND globally
- Publish both alerts and passed checks to audit topic

### 4.4 Audit Trail

**Acceptance Criteria:**
- Consume all messages from `audit` topic
- Structured logging with: `source`, `action`, `orderId`, `instanceId`, `timestamp`
- No data persistence (logs to stdout)

---

## 5. Event Schemas

```mermaid
erDiagram
    ORDER_EVENT {
        string action "created|updated|deleted"
        Order order
        timestamp timestamp
    }

    ORDER {
        uuid id PK
        string customerName
        string item
        int quantity
        decimal price
        string status
        timestamp createdAt
    }

    AUDIT_EVENT {
        string source "order-service|notification-service|fraud-service"
        string action "created|NOTIFIED|RETRY|DLQ|FRAUD_ALERT|FRAUD_CHECK_PASSED"
        uuid orderId FK
        string instanceId "optional"
        string customerName "optional - fraud events"
        int retryCount "optional"
        FraudAlert[] alerts "optional - fraud alerts only"
        WindowStats windowStats "optional - fraud events"
        timestamp timestamp
    }

    FRAUD_ALERT {
        string type "VELOCITY|BURST|AMOUNT"
        string reason "human-readable explanation"
        string severity "HIGH|MEDIUM|LOW"
    }

    WINDOW_STATS {
        int customerOrdersInWindow "orders from this customer in window"
        int globalOrdersInWindow "total orders in window"
    }

    DLQ_EVENT {
        string action
        Order order
        string reason
        string instanceId
        timestamp timestamp
    }

    ORDER_EVENT ||--|| ORDER : contains
    AUDIT_EVENT }o--|| ORDER : references
    DLQ_EVENT ||--|| ORDER : contains
```

---

## 6. Topic Design

```mermaid
flowchart TB
    subgraph Topics
        orders[("orders<br/>─────────<br/>partitions: 3<br/>replication: 1")]
        audit[("audit<br/>─────────<br/>partitions: 1<br/>replication: 1")]
        dlq[("orders-dlq<br/>─────────<br/>partitions: 1<br/>replication: 1")]
    end

    subgraph "Consumer Groups"
        ng["notification-group<br/>(2 instances)"]
        fg["fraud-group<br/>(1 instance)"]
        aug["audit-group<br/>(1 instance)"]
        rg["sse-relay-group<br/>(1 instance)"]
    end

    orders --> ng
    orders --> fg
    audit --> aug
    audit --> rg
    dlq --> rg
```

**Key decisions:**
- `orders` has 3 partitions → enables 2 notification instances to share load
- `audit` and `dlq` are single-partition → ordering matters, low volume
- Each service has its own consumer group → independent offsets

---

## 7. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| **Deployment** | Single `docker compose up` to start everything |
| **Hot Reload** | Code changes reflect without container restart |
| **Observability** | Kafka UI available for topic inspection |
| **Simplicity** | No external database; in-memory state only |
| **Isolation** | Each service in its own container |

---

## 8. Deployment Architecture

```mermaid
flowchart TB
    subgraph Docker["Docker Compose"]
        subgraph Infra["Infrastructure"]
            kafka[Apache Kafka<br/>:9092]
            init[kafka-init<br/>topic creation]
            ui[Kafka UI<br/>:8080]
        end

        subgraph Services["Application Services"]
            order[Order Service<br/>:3001]
            n1[notification-1]
            n2[notification-2]
            fraud[Fraud Detection]
            audit[Audit Service]
        end
    end

    Browser --> order
    Browser --> ui

    init -->|creates topics| kafka
    order & n1 & n2 & fraud & audit <--> kafka
    ui --> kafka
```

---

## 9. Workshop Flow

```mermaid
journey
    title Workshop Participant Journey
    section Setup
      Run docker compose: 5: Participant
      Open dashboard: 5: Participant
      Open Kafka UI: 5: Participant
    section Create Order
      Submit order form: 5: Participant
      See order in list: 5: System
      Watch audit events appear: 5: System
    section Observe Failures
      Notice RETRY events: 4: System
      See DLQ entry: 3: System
      Check orders-dlq topic: 4: Participant
    section Explore
      Scale notification instances: 4: Participant
      Adjust FAIL_RATE: 4: Participant
      Inspect partition distribution: 4: Participant
```

---

## 10. Success Metrics

This workshop is successful when participants can answer:

1. **Why Kafka?** → Decoupling, fault tolerance, replay, scaling
2. **What is a consumer group?** → Multiple instances share partitions
3. **How do retries work?** → Re-produce with header, check count
4. **What is a DLQ?** → Parking lot for failed messages after max retries
5. **How does scaling work?** → Add consumers up to partition count

---

*Generated as a retrospective spec document for the Kafka Dojo workshop demo.*
