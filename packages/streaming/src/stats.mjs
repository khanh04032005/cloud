import { parseAnswerEvent, secondBucket } from "./contract.mjs"

export async function applyStats(db, redis, bloom, rawEvent, mode = "bloom") {
  const event = parseAnswerEvent(rawEvent)
  const maybeDuplicate = bloom.has(event.event_id)
  let prechecked = false

  if (mode === "db" || maybeDuplicate) {
    prechecked = true
    const existing = await db.query(
      "SELECT 1 FROM stats_processed_events WHERE event_id = $1",
      [event.event_id],
    )

    if (existing.rowCount) {
      await redis.pfAdd(`razzia:unique:${event.room_id}`, event.player_id)

      return { isNew: false, prechecked, falsePositive: false }
    }
  }

  await db.query("BEGIN")

  try {
    const inserted = await db.query(
      `INSERT INTO stats_processed_events (event_id)
       VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.event_id],
    )
    const isNew = inserted.rowCount === 1

    if (isNew) {
      await db.query(
        `INSERT INTO answer_rate_buckets (room_id, bucket_start, answer_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (room_id, bucket_start)
         DO UPDATE SET answer_count = answer_rate_buckets.answer_count + 1`,
        [event.room_id, secondBucket(event.accepted_at)],
      )
    }

    await db.query("COMMIT")
    bloom.add(event.event_id)
    await redis.pfAdd(`razzia:unique:${event.room_id}`, event.player_id)

    return { isNew, prechecked, falsePositive: maybeDuplicate && isNew }
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  }
}
