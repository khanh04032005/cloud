import { parseAnswerEvent } from "./contract.mjs"

export async function publishBatch(db, producer, topic, batchSize = 100) {
  await db.query("BEGIN")

  try {
    const { rows } = await db.query(
      `SELECT o.event_id, a.room_id, a.round_id, a.player_id,
              a.choice, a.answer_keys, a.is_correct, a.accepted_at
       FROM outbox o JOIN answers a USING (round_id, player_id)
       WHERE o.published_at IS NULL ORDER BY o.created_at, o.event_id
       LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
      [batchSize],
    )
    const messages = rows.map((row) => {
      const event = parseAnswerEvent({
        ...row,
        accepted_at: row.accepted_at.toISOString(),
      })

      return {
        key: row.room_id,
        value: JSON.stringify(event),
        headers: { event_id: row.event_id },
      }
    })

    if (messages.length > 0) {
      await producer.send({ topic, acks: -1, messages })
      await db.query(
        "UPDATE outbox SET published_at = now() WHERE event_id = ANY($1::uuid[])",
        [rows.map((row) => row.event_id)],
      )
    }
    await db.query("COMMIT")

    return rows.length
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  }
}
