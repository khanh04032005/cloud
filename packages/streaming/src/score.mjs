import { loadAcceptedEvent } from "./accepted-event.mjs"

export async function applyScore(db, rawEvent) {
  await db.query("BEGIN")

  try {
    const event = await loadAcceptedEvent(db, rawEvent)
    const inserted = await db.query(
      `INSERT INTO processed_answer_events (event_id)
       VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.event_id],
    )
    const isNew = inserted.rowCount === 1

    if (isNew) {
      await db.query(
        `INSERT INTO results (room_id, player_id, points)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, player_id)
         DO UPDATE SET points = results.points + EXCLUDED.points`,
        [event.room_id, event.player_id, event.is_correct ? 1 : 0],
      )
    }

    await db.query("COMMIT")

    return { isNew, roomId: event.room_id }
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  }
}
