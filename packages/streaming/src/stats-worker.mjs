import { BloomFilter } from "./bloom.mjs"
import { config } from "./config.mjs"
import { inc } from "./metrics.mjs"
import { connectRedis, pool } from "./runtime.mjs"
import { applyStats } from "./stats.mjs"
import { runWorker } from "./consume.mjs"

const redis = await connectRedis()
const bloom = new BloomFilter()
await runWorker("razzia-stats", 9103, async (raw) => {
  const db = await pool.connect()

  try {
    const result = await applyStats(db, redis, bloom, raw, config.statsMode)

    if (result.isNew) {
      inc("razzia_stats_events_total")
    } else {
      inc("razzia_stats_duplicates_total")
    }
    if (result.prechecked) {
      inc("razzia_stats_db_prechecks_total")
    }
    if (result.falsePositive) {
      inc("razzia_stats_bloom_false_positive_total")
    }
  } finally {
    db.release()
  }
})
