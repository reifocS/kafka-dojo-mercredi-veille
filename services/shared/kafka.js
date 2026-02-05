const { Kafka } = require('@confluentinc/kafka-javascript').KafkaJS;

const kafka = new Kafka({
  kafkaJS: {
    brokers: [process.env.KAFKA_BROKER || 'localhost:29092'],
    clientId: process.env.SERVICE_NAME || 'kafka-dojo',
  }
});

module.exports = { kafka };
