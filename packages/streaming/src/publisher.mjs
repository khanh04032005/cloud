import { config } from "./config.mjs"
import { kafka, pool, shutdownOnSignal } from "./runtime.mjs"
import { inc, startMetrics } from "./metrics.mjs"
import { publishBatch } from "./outbox.mjs"

const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5 })
const metrics = startMetrics(Number(process.env.METRICS_PORT ?? 9101))
shutdownOnSignal([
  producer,
  pool,
  { end: () => new Promise((resolve) => metrics.close(resolve)) },
])

async function publishPending() {
  const db = await pool.connect()

  try {
    return await publishBatch(db, producer, config.topic, config.batchSize)
  } finally {
    db.release()
  }
}

await producer.connect()
console.log(`Outbox publisher started; topic=${config.topic}`)

while (true) {
  try {
    const count = await publishPending()
    inc("razzia_outbox_published_total", count)

    if (count === 0) {
      await new Promise((resolve) => setTimeout(resolve, config.pollMs))
    }
  } catch (error) {
    inc("razzia_outbox_errors_total")
    console.error("Outbox publish failed", error)
    await new Promise((resolve) => setTimeout(resolve, config.pollMs))
  }
}
