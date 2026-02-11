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
  broadcast('order', { action: 'created', order });
  broadcast('audit', { source: 'order-service', action: 'created', orderId: order.id, timestamp: new Date().toISOString() });
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
  broadcast('order', { action: 'updated', order });
  broadcast('audit', { source: 'order-service', action: 'updated', orderId: order.id, timestamp: new Date().toISOString() });
  res.json(order);
});

app.delete('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  orders.delete(order.id);
  order.status = 'deleted';
  await produceEvent('orders', 'deleted', order);
  broadcast('order', { action: 'deleted', order });
  broadcast('audit', { source: 'order-service', action: 'deleted', orderId: order.id, timestamp: new Date().toISOString() });
  res.json(order);
});

// Internal consumer — relay notification/fraud/DLQ events to SSE
async function startRelayConsumer() {
  const consumer = kafka.consumer({ kafkaJS: { groupId: 'sse-relay-group' } });
  await consumer.connect();
  await consumer.subscribe({ topics: ['notifications', 'fraud-checks', 'orders-dlq'] });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const data = JSON.parse(message.value.toString());
      if (topic === 'notifications' || topic === 'fraud-checks') {
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
