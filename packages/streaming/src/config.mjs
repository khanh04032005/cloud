function positiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback)

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export const config = {
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092")
    .split(",")
    .map((x) => x.trim()),
  topic: process.env.KAFKA_TOPIC ?? "answers",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://razzia:razzia@localhost:5432/razzia",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  pollMs: positiveInt("OUTBOX_POLL_MS", 500),
  batchSize: positiveInt("OUTBOX_BATCH_SIZE", 100),
  statsMode: process.env.STATS_DEDUP_MODE ?? "bloom",
}

if (!["bloom", "db"].includes(config.statsMode)) {
  throw new Error("STATS_DEDUP_MODE must be bloom or db")
}
