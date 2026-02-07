const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { kafka } = require('../shared/kafka');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const orders = new Map();
const sseClients = new Set();

// SSE helpers
function broadcast(type, data) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  for (const res of sseClients) {
    res.write(`data: ${message}\n\n`);
  }
}

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Producer
const producer = kafka.producer();

async function produceEvent(topic, action, order, headers = {}) {
  await producer.send({
    topic,
    messages: [{
      key: order.id,
      value: JSON.stringify({ action, order, timestamp: new Date().toISOString() }),
      headers,
    }],
  });
}

async function produceAudit(action, order) {
  await producer.send({
    topic: 'audit',
    messages: [{
      key: order.id,
      value: JSON.stringify({
        source: 'order-service',
        action,
        orderId: order.id,
        order,
        timestamp: new Date().toISOString(),
      }),
    }],
  });
}

// Publish to compacted topic — only latest status per order is retained
async function produceOrderStatus(order) {
  await producer.send({
    topic: 'order-status',
    messages: [{
      key: order.id,
      // For deletes, send null value (tombstone) to remove from compacted log
      value: order.status === 'deleted' ? null : JSON.stringify({
        id: order.id,
        customerName: order.customerName,
        item: order.item,
        status: order.status,
        updatedAt: new Date().toISOString(),
      }),
    }],
  });
}

// REST routes
app.post('/api/orders', async (req, res) => {
  const { customerName, item, quantity, price } = req.body;
  const order = {
    id: uuidv4(),
    customerName,
    item,
    quantity,
    price,
    status: 'created',
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  await produceEvent('orders', 'created', order);
  await produceAudit('created', order);
  await produceOrderStatus(order);
  broadcast('order', { action: 'created', order });
  res.status(201).json(order);
});

app.get('/api/orders', (_req, res) => {
  res.json([...orders.values()]);
});

app.put('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  Object.assign(order, req.body);
  orders.set(order.id, order);
  await produceEvent('orders', 'updated', order);
  await produceAudit('updated', order);
  await produceOrderStatus(order);
  broadcast('order', { action: 'updated', order });
  res.json(order);
});

app.delete('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  orders.delete(order.id);
  order.status = 'deleted';
  await produceEvent('orders', 'deleted', order);
  await produceAudit('deleted', order);
  await produceOrderStatus(order);  // sends tombstone (null) to remove from compacted log
  broadcast('order', { action: 'deleted', order });
  res.json(order);
});

// Internal consumer — relay audit + DLQ events to SSE
async function startRelayConsumer() {
  const consumer = kafka.consumer({ kafkaJS: { groupId: 'sse-relay-group' } });
  await consumer.connect();
  await consumer.subscribe({ topics: ['audit', 'orders-dlq'] });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const data = JSON.parse(message.value.toString());
      if (topic === 'audit') {
        broadcast('audit', data);
      } else if (topic === 'orders-dlq') {
        broadcast('dlq', data);
      }
    },
  });
}

// Startup
async function start() {
  await producer.connect();
  await startRelayConsumer();
  app.listen(PORT, () => console.log(`[Order Service] listening on port ${PORT}`));
}

start().catch(console.error);
