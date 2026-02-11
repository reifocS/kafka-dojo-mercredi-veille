const { kafka } = require('../shared/kafka');

const consumer = kafka.consumer({ kafkaJS: { groupId: 'audit-group' } });

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topics: ['orders', 'notifications', 'fraud-checks', 'orders-dlq'] });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const event = JSON.parse(message.value.toString());
      const time = new Date().toISOString();

      if (topic === 'orders') {
        // Skip retry messages — already logged by notification-service
        if (message.headers?.retryCount) return;
        const { action, order } = event;
        console.log(
          `[AUDIT ${time}] source=order-service action=${action}` +
          ` orderId=${order.id.slice(0, 8)}…` +
          ` customer=${order.customerName}`
        );
      } else if (topic === 'notifications') {
        console.log(
          `[AUDIT ${time}] source=${event.source} action=${event.action}` +
          (event.orderId ? ` orderId=${event.orderId.slice(0, 8)}…` : '') +
          (event.instanceId ? ` instance=${event.instanceId}` : '') +
          (event.retryCount !== undefined ? ` retryCount=${event.retryCount}` : '')
        );
      } else if (topic === 'fraud-checks') {
        console.log(
          `[AUDIT ${time}] source=${event.source} action=${event.action}` +
          (event.orderId ? ` orderId=${event.orderId.slice(0, 8)}…` : '') +
          (event.customerName ? ` customer=${event.customerName}` : '')
        );
      } else if (topic === 'orders-dlq') {
        console.log(
          `[AUDIT ${time}] source=DLQ action=${event.action}` +
          (event.order ? ` orderId=${event.order.id.slice(0, 8)}…` : '') +
          ` reason=${event.reason}`
        );
      }
    },
  });

  console.log('[Audit] Audit service running — listening to orders, notifications, fraud-checks, orders-dlq');
}

start().catch(console.error);
