import { parseAnswerEvent } from "./contract.mjs"

export async function publishBatch(db, producer, topic, batchSize = 100) {
  await db.query("BEGIN")

  try {
    const { rows } = await db.query(
      `SELECT event_id, room_id, payload FROM outbox
       WHERE published_at IS NULL ORDER BY created_at, event_id
       FOR UPDATE SKIP LOCKED LIMIT $1`,
      [batchSize],
    )
    const messages = rows.map((row) => {
      const event = parseAnswerEvent(row.payload)

      if (event.event_id !== row.event_id || event.room_id !== row.room_id) {
        throw new Error(`Outbox envelope does not match row ${row.event_id}`)
      }

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
