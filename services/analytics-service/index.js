const { kafka } = require('../shared/kafka');

const producer = kafka.producer();
const consumer = kafka.consumer({ kafkaJS: { groupId: 'analytics-group', fromBeginning: true } });

// Time-windowed metrics (can't derive from DB!)
const WINDOW_MS = 60_000; // 1 minute window
const eventTimestamps = []; // sliding window of event times
const notificationOutcomes = { NOTIFIED: 0, RETRY: 0, DLQ: 0 };
const orderLifecycle = new Map(); // orderId -> { createdAt, notifiedAt }

function pruneOldEvents() {
  const cutoff = Date.now() - WINDOW_MS;
  while (eventTimestamps.length && eventTimestamps[0] < cutoff) {
    eventTimestamps.shift();
  }
}

function getStats() {
  pruneOldEvents();

  // Calculate avg notification latency from lifecycle data
  let totalLatency = 0;
  let latencyCount = 0;
  for (const [, lifecycle] of orderLifecycle) {
    if (lifecycle.createdAt && lifecycle.notifiedAt) {
      totalLatency += lifecycle.notifiedAt - lifecycle.createdAt;
      latencyCount++;
    }
  }

  return {
    ordersPerMinute: eventTimestamps.length,
    notificationOutcomes: { ...notificationOutcomes },
    notificationSuccessRate: notificationOutcomes.NOTIFIED + notificationOutcomes.RETRY + notificationOutcomes.DLQ > 0
      ? ((notificationOutcomes.NOTIFIED / (notificationOutcomes.NOTIFIED + notificationOutcomes.DLQ)) * 100).toFixed(1) + '%'
      : 'N/A',
    avgNotificationLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : null,
  };
}

async function start() {
  await producer.connect();
  await consumer.connect();
  // Subscribe to both topics - we need the event flow, not just current state
  await consumer.subscribe({ topics: ['orders', 'audit'] });

  console.log('[Analytics] Rebuilding state from event history...');

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const data = JSON.parse(message.value.toString());
      const now = Date.now();

      if (topic === 'orders') {
        // Skip retries for order counting
        if (message.headers?.retryCount) return;

        eventTimestamps.push(now);

        if (data.action === 'created') {
          orderLifecycle.set(data.order.id, { createdAt: now, notifiedAt: null });
        }
      }

      if (topic === 'audit' && data.source === 'notification-service') {
        // Track notification outcomes - this is event-native!
        if (data.action === 'NOTIFIED') {
          notificationOutcomes.NOTIFIED++;
          const lifecycle = orderLifecycle.get(data.orderId);
          if (lifecycle) lifecycle.notifiedAt = now;
        } else if (data.action === 'RETRY') {
          notificationOutcomes.RETRY++;
        } else if (data.action === 'DLQ') {
          notificationOutcomes.DLQ++;
        }
      }

      // Only emit stats on order events (not every audit event)
      if (topic === 'orders' && !message.headers?.retryCount) {
        const stats = getStats();
        console.log(`[Analytics] orders/min=${stats.ordersPerMinute} successRate=${stats.notificationSuccessRate} latency=${stats.avgNotificationLatencyMs ?? '-'}ms`);

        await producer.send({
          topic: 'audit',
          messages: [{
            key: data.order.id,
            value: JSON.stringify({
              source: 'analytics',
              action: 'STREAM_STATS',
              orderId: data.order.id,
              stats,
              timestamp: new Date().toISOString(),
            }),
          }],
        });
      }
    },
  });

  console.log('[Analytics] Analytics service running (tracking event-stream metrics)');
}

start().catch(console.error);
