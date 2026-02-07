const { kafka } = require('../shared/kafka');

// Replay mode: set REPLAY=true to create a fresh consumer group and replay from beginning
const REPLAY_MODE = process.env.REPLAY === 'true';
const GROUP_ID = REPLAY_MODE ? `fraud-replay-${Date.now()}` : 'fraud-group';

const producer = kafka.producer();
const consumer = kafka.consumer({
  kafkaJS: {
    groupId: GROUP_ID,
    fromBeginning: REPLAY_MODE,
  }
});

// Sliding window state — can't do this with a simple DB query
const WINDOW_MS = 10_000; // 10 second window (short for demo purposes)
const customerOrders = new Map(); // customerName -> [{ timestamp, amount }]
const globalOrders = []; // all orders in window (for burst detection)

// Thresholds (tuned for workshop demo)
const MAX_ORDERS_PER_CUSTOMER = 3; // per 10 seconds
const MAX_GLOBAL_BURST = 15; // orders per 10 seconds across all customers
const SUSPICIOUS_AMOUNT = 100; // unusually high order value

function pruneWindow(arr, cutoff) {
  while (arr.length && arr[0].timestamp < cutoff) arr.shift();
}

function detectFraud(order, timestamp) {
  const alerts = [];
  const cutoff = timestamp - WINDOW_MS;

  // 1. Velocity check — same customer ordering too fast
  const customerHistory = customerOrders.get(order.customerName) || [];
  pruneWindow(customerHistory, cutoff);
  customerHistory.push({ timestamp, amount: order.price * order.quantity });
  customerOrders.set(order.customerName, customerHistory);

  if (customerHistory.length > MAX_ORDERS_PER_CUSTOMER) {
    alerts.push({
      type: 'VELOCITY',
      reason: `${order.customerName} placed ${customerHistory.length} orders in 10s (limit: ${MAX_ORDERS_PER_CUSTOMER})`,
      severity: 'HIGH',
    });
  }

  // 2. Burst detection — too many orders globally (bot attack pattern)
  pruneWindow(globalOrders, cutoff);
  globalOrders.push({ timestamp });

  if (globalOrders.length > MAX_GLOBAL_BURST) {
    alerts.push({
      type: 'BURST',
      reason: `${globalOrders.length} orders in 10s across all customers (threshold: ${MAX_GLOBAL_BURST})`,
      severity: 'MEDIUM',
    });
  }

  // 3. Amount anomaly — unusually high value order
  const orderTotal = order.price * order.quantity;
  if (orderTotal > SUSPICIOUS_AMOUNT) {
    alerts.push({
      type: 'AMOUNT',
      reason: `Order total $${orderTotal.toFixed(2)} exceeds $${SUSPICIOUS_AMOUNT} threshold`,
      severity: 'LOW',
    });
  }

  return alerts;
}

async function start() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'orders' });

  if (REPLAY_MODE) {
    console.log('[Fraud] REPLAY MODE — reading all events from beginning');
  }

  await consumer.run({
    eachMessage: async ({ message }) => {
      // Skip retries — already analyzed
      if (message.headers?.retryCount) return;

      const { action, order } = JSON.parse(message.value.toString());
      if (action !== 'created') return; // only analyze new orders

      const now = Date.now();
      const alerts = detectFraud(order, now);

      if (alerts.length > 0) {
        console.log(`[Fraud] ALERT on order ${order.id.slice(0, 8)}… — ${alerts.map(a => a.type).join(', ')}`);

        await producer.send({
          topic: 'audit',
          messages: [{
            key: order.id,
            value: JSON.stringify({
              source: 'fraud-service',
              action: 'FRAUD_ALERT',
              orderId: order.id,
              customerName: order.customerName,
              alerts,
              windowStats: {
                customerOrdersInWindow: customerOrders.get(order.customerName)?.length || 0,
                globalOrdersInWindow: globalOrders.length,
              },
              timestamp: new Date().toISOString(),
            }),
          }],
        });
      } else {
        console.log(`[Fraud] OK order ${order.id.slice(0, 8)}… — customer=${order.customerName} window=${customerOrders.get(order.customerName)?.length || 1}`);

        await producer.send({
          topic: 'audit',
          messages: [{
            key: order.id,
            value: JSON.stringify({
              source: 'fraud-service',
              action: 'FRAUD_CHECK_PASSED',
              orderId: order.id,
              customerName: order.customerName,
              windowStats: {
                customerOrdersInWindow: customerOrders.get(order.customerName)?.length || 0,
                globalOrdersInWindow: globalOrders.length,
              },
              timestamp: new Date().toISOString(),
            }),
          }],
        });
      }
    },
  });

  console.log('[Fraud] Fraud detection service running');
  console.log(`[Fraud] Thresholds: velocity=${MAX_ORDERS_PER_CUSTOMER}/10s, burst=${MAX_GLOBAL_BURST}/10s, amount=$${SUSPICIOUS_AMOUNT}`);
}

start().catch(console.error);
