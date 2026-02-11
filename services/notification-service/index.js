const { kafka } = require('../shared/kafka');

const express = require('express');
const INSTANCE_ID = process.env.INSTANCE_ID || 'notification-0';
let FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0.3');
let failMode = process.env.FAIL_MODE || 'dlq'; // dlq | drop | retry-forever

const app = express();
app.get('/fail-rate', (_req, res) => res.json({ failRate: FAIL_RATE }));
app.put('/fail-rate/:rate', (req, res) => {
  FAIL_RATE = parseFloat(req.params.rate);
  console.log(`[${INSTANCE_ID}] Fail rate changed to ${FAIL_RATE}`);
  res.json({ failRate: FAIL_RATE });
});
app.get('/fail-mode', (_req, res) => res.json({ mode: failMode }));
app.put('/fail-mode/:mode', (req, res) => {
  failMode = req.params.mode;
  console.log(`[${INSTANCE_ID}] Fail mode changed to ${failMode}`);
  res.json({ mode: failMode });
});
app.listen(process.env.NOTIF_PORT || 4000);

const producer = kafka.producer();
const consumer = kafka.consumer({ kafkaJS: { groupId: 'notification-group' } });

async function produceOutcome(action, order, extra = {}) {
  await producer.send({
    topic: 'notifications',
    messages: [{
      key: order.id,
      value: JSON.stringify({
        source: 'notification-service',
        action,
        orderId: order.id,
        instanceId: INSTANCE_ID,
        timestamp: new Date().toISOString(),
        ...extra,
      }),
    }],
  });
}

async function start() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'orders' });

  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      const { action, order } = JSON.parse(message.value.toString());
      const retryCount = parseInt(message.headers?.retryCount?.toString() || '0');

      console.log(`[${INSTANCE_ID}] partition=${partition} action=${action} order=${order.id.slice(0, 8)}… retry=${retryCount}`);

      // Simulate failure
      if (Math.random() < FAIL_RATE) {
        if (failMode === 'retry-forever' || retryCount < 2) {
          console.log(`[${INSTANCE_ID}] -> RETRY (${retryCount + 1}) order=${order.id.slice(0, 8)}…`);
          await producer.send({
            topic: 'orders',
            messages: [{
              key: order.id,
              value: message.value.toString(),
              headers: { retryCount: String(retryCount + 1) },
            }],
          });
          await produceOutcome('RETRY', order, { retryCount: retryCount + 1 });
        } else if (failMode === 'dlq') {
          console.log(`[${INSTANCE_ID}] -> DLQ (max retries) order=${order.id.slice(0, 8)}…`);
          await producer.send({
            topic: 'orders-dlq',
            messages: [{
              key: order.id,
              value: JSON.stringify({
                action, order, reason: 'Max retries exceeded',
                instanceId: INSTANCE_ID,
                timestamp: new Date().toISOString(),
              }),
            }],
          });
          await produceOutcome('DLQ', order, { retryCount });
        } else {
          console.log(`[${INSTANCE_ID}] -> DROPPED (no DLQ) order=${order.id.slice(0, 8)}…`);
          await produceOutcome('DROPPED', order, { retryCount });
        }
      } else {
        console.log(`[${INSTANCE_ID}] -> NOTIFIED order=${order.id.slice(0, 8)}…`);
        await produceOutcome('NOTIFIED', order);
      }
    },
  });

  console.log(`[${INSTANCE_ID}] Notification service running (failRate=${FAIL_RATE})`);
}

start().catch(console.error);
