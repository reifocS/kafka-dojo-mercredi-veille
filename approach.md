  1. REST approach — everything coupled, fragile, synchronous
  2. Introduce EDA concept — decouple via events, Kafka as one implementation (quick Kafka vs RabbitMQ aside)
    Parallèle avec la programmation - pattern pub/sub
  3. Kafka UI tour — topics, partitions, consumer groups, offsets
  4. Live app demo — create orders, watch events flow through SSE
  5. Consumer parallelism — spin up notification-2, show partition rebalancing in Kafka UI
    Rex LCL
  6. Error handling — toggle fail rate, show retries, DLQ flow
    Rex LCL
  7. Fraud detection — stateful stream processing, sliding windows, spam 10 orders to trigger velocity alerts
  8. Usage à LCL - Event de lifecycle, CRON, search engine
  9. Différence avec autre système de messaging (RabbitMQ, SQS, etc.) — Kafka est un log, pas une file d’attente, ce qui permet de rejouer les événements, de les traiter à différents rythmes, etc.
  
