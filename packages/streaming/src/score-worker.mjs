import { connectRedis, pool } from "./runtime.mjs"
import { applyScore } from "./score.mjs"
import { inc } from "./metrics.mjs"
import { runWorker } from "./consume.mjs"

const redis = await connectRedis()
await runWorker("razzia-score", 9102, async (raw) => {
  const db = await pool.connect()
  let result

  try {
    result = await applyScore(db, raw)
  } finally {
    db.release()
  }

  await redis.publish(
    `razzia:leaderboard:${result.roomId}`,
    JSON.stringify({
      roomId: result.roomId,
      players: result.leaderboard,
    }),
  )
  inc(
    result.isNew
      ? "razzia_score_events_total"
      : "razzia_score_duplicates_total",
  )
})
