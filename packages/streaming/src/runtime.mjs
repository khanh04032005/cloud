import { Kafka, logLevel } from "kafkajs"
import pg from "pg"
import { createClient } from "redis"
import { config } from "./config.mjs"

export const pool = new pg.Pool({ connectionString: config.databaseUrl })

export const kafka = new Kafka({
  clientId: "razzia-streaming",
  brokers: config.brokers,
  logLevel: logLevel.WARN,
})

export async function withTransaction(work) {
  const client = await pool.connect()

  try {
    await client.query("BEGIN")
    const result = await work(client)
    await client.query("COMMIT")

    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function connectRedis() {
  const redis = createClient({ url: config.redisUrl })
  redis.on("error", (error) => console.error("Redis error", error))
  await redis.connect()

  return redis
}

export function shutdownOnSignal(resources) {
  let closing = false
  const close = async () => {
    if (closing) {
      return
    }
    closing = true
    await Promise.allSettled(
      resources.map((resource) => resource.disconnect?.() ?? resource.end?.()),
    )
    process.exit(0)
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}
