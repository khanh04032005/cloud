import { pool, connectRedis } from "../src/runtime.mjs"

const roomId = process.argv[2]

if (!roomId) {
  throw new Error("Usage: node scripts/stats-query.mjs <room_id>")
}
const redis = await connectRedis()

try {
  const [uniquePlayers, buckets, scores] = await Promise.all([
    redis.pfCount(`razzia:unique:${roomId}`),
    pool.query(
      `SELECT bucket_start, answer_count FROM answer_rate_buckets
       WHERE room_id = $1 ORDER BY bucket_start`,
      [roomId],
    ),
    pool.query(
      "SELECT player_id, points FROM player_scores WHERE room_id = $1 ORDER BY points DESC, player_id",
      [roomId],
    ),
  ])
  console.log(
    JSON.stringify(
      {
        roomId,
        uniquePlayers,
        leaderboard: scores.rows,
        answersPerSecond: buckets.rows,
      },
      null,
      2,
    ),
  )
} finally {
  await redis.quit()
  await pool.end()
}
