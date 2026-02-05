const { kafka } = require('../shared/kafka');

const producer = kafka.producer();
const consumer = kafka.consumer({ kafkaJS: { groupId: 'analytics-group' } });

const stats = { totalOrders: 0, totalRevenue: 0, byAction: {} };

async function start() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'orders' });

  await consumer.run({
    eachMessage: async ({ message }) => {
      // Skip retried messages to avoid double-counting
      if (message.headers?.retryCount) return;

      const { action, order } = JSON.parse(message.value.toString());

      stats.byAction[action] = (stats.byAction[action] || 0) + 1;

      if (action === 'created') {
        stats.totalOrders++;
        stats.totalRevenue += order.price * order.quantity;
      } else if (action === 'deleted') {
        stats.totalOrders = Math.max(0, stats.totalOrders - 1);
        stats.totalRevenue = Math.max(0, stats.totalRevenue - order.price * order.quantity);
      }

      console.log(`[Analytics] action=${action} totalOrders=${stats.totalOrders} revenue=$${stats.totalRevenue.toFixed(2)}`);

      await producer.send({
        topic: 'audit',
        messages: [{
          key: order.id,
          value: JSON.stringify({
            source: 'analytics',
            action: 'STATS_UPDATED',
            orderId: order.id,
            stats: { ...stats, byAction: { ...stats.byAction } },
            timestamp: new Date().toISOString(),
          }),
        }],
      });
    },
  });

  console.log('[Analytics] Analytics service running');
}

start().catch(console.error);
