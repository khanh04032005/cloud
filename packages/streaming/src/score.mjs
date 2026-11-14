import { parseAnswerEvent } from "./contract.mjs"

export async function applyScore(db, rawEvent) {
  const event = parseAnswerEvent(rawEvent)
  await db.query("BEGIN")

  try {
    const inserted = await db.query(
      `INSERT INTO score_processed_events (event_id)
       VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.event_id],
    )
    const isNew = inserted.rowCount === 1

    if (isNew) {
      await db.query(
        `INSERT INTO player_scores (room_id, player_id, points)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, player_id)
         DO UPDATE SET points = player_scores.points + EXCLUDED.points`,
        [event.room_id, event.player_id, event.is_correct ? 1 : 0],
      )
    }

    const { rows } = await db.query(
      `SELECT player_id, points FROM player_scores
       WHERE room_id = $1 ORDER BY points DESC, player_id ASC`,
      [event.room_id],
    )
    await db.query("COMMIT")

    return { isNew, roomId: event.room_id, leaderboard: rows }
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  }
}
