const { kafka } = require('../shared/kafka');

const INSTANCE_ID = process.env.INSTANCE_ID || 'notification-0';
const FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0.3');

const producer = kafka.producer();
const consumer = kafka.consumer({ kafkaJS: { groupId: 'notification-group' } });

async function produceAudit(action, order, extra = {}) {
  await producer.send({
    topic: 'audit',
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
        if (retryCount >= 3) {
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
          await produceAudit('DLQ', order, { retryCount });
        } else {
          console.log(`[${INSTANCE_ID}] -> RETRY (${retryCount + 1}) order=${order.id.slice(0, 8)}…`);
          await producer.send({
            topic: 'orders',
            messages: [{
              key: order.id,
              value: message.value.toString(),
              headers: { retryCount: String(retryCount + 1) },
            }],
          });
          await produceAudit('RETRY', order, { retryCount: retryCount + 1 });
        }
      } else {
        console.log(`[${INSTANCE_ID}] -> NOTIFIED order=${order.id.slice(0, 8)}…`);
        await produceAudit('NOTIFIED', order);
      }
    },
  });

  console.log(`[${INSTANCE_ID}] Notification service running (failRate=${FAIL_RATE})`);
}

start().catch(console.error);
