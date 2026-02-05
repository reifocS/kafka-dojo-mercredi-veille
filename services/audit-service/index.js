const { kafka } = require('../shared/kafka');

const consumer = kafka.consumer({ kafkaJS: { groupId: 'audit-group' } });

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'audit' });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value.toString());
      const time = new Date(event.timestamp).toISOString();
      console.log(
        `[AUDIT ${time}] source=${event.source} action=${event.action}` +
        (event.orderId ? ` orderId=${event.orderId.slice(0, 8)}…` : '') +
        (event.instanceId ? ` instance=${event.instanceId}` : '') +
        (event.retryCount !== undefined ? ` retryCount=${event.retryCount}` : '')
      );
    },
  });

  console.log('[Audit] Audit service running');
}

start().catch(console.error);
