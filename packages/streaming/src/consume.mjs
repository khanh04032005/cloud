import { config } from "./config.mjs"
import { kafka, pool, shutdownOnSignal } from "./runtime.mjs"
import { inc, setGauge, startMetrics } from "./metrics.mjs"

export async function runWorker(groupId, port, handle) {
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false })
  const admin = kafka.admin()
  const server = startMetrics(Number(process.env.METRICS_PORT ?? port))
  shutdownOnSignal([
    consumer,
    admin,
    pool,
    { end: () => new Promise((resolve) => server.close(resolve)) },
  ])
  await admin.connect()
  await consumer.connect()
  await consumer.subscribe({ topic: config.topic, fromBeginning: true })

  const updateLag = async () => {
    try {
      const latest = await admin.fetchTopicOffsets(config.topic)
      const committed = await admin.fetchOffsets({
        groupId,
        topics: [config.topic],
      })
      const offsets = new Map(
        committed.flatMap(({ partitions }) =>
          partitions.map(({ partition, offset }) => [
            partition,
            Number(offset),
          ]),
        ),
      )
      const lag = latest.reduce((sum, { partition, offset }) => {
        const current = offsets.get(partition)

        return (
          sum +
          Math.max(
            0,
            Number(offset) -
              (current === undefined || current < 0 ? 0 : current),
          )
        )
      }, 0)
      setGauge(`razzia_kafka_consumer_lag{group="${groupId}"}`, lag)
    } catch (error) {
      console.error("Cannot fetch consumer lag", error)
      inc("razzia_kafka_lag_errors_total")
    }
  }
  console.log(`${groupId} worker started; topic=${config.topic}`)
  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      if (!message.value) {
        throw new Error(`Empty Kafka message at ${partition}:${message.offset}`)
      }
      await handle(message.value.toString())
      await consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ])
      inc("razzia_kafka_messages_processed_total")
    },
  })
  const timer = setInterval(updateLag, 15000)
  timer.unref()
  void updateLag()
}
