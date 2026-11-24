import { parseAnswerEvent } from "./contract.mjs"

// Room membership alone cannot prove that an event belongs to that room: the
// same client may join several rooms. Resolve its identity through the outbox.
export async function loadAcceptedEvent(db, rawEvent) {
  const event = parseAnswerEvent(rawEvent)
  const { rows } = await db.query(
    `SELECT o.event_id, a.room_id, a.round_id, a.player_id,
            a.choice, a.answer_keys, a.is_correct, a.accepted_at
     FROM outbox o JOIN answers a USING (round_id, player_id)
     WHERE o.event_id = $1 AND a.room_id = $2
       AND a.round_id = $3 AND a.player_id = $4`,
    [event.event_id, event.room_id, event.round_id, event.player_id],
  )
  const answer = rows[0]
  if (
    !answer ||
    answer.choice !== event.choice ||
    answer.is_correct !== event.is_correct ||
    JSON.stringify(answer.answer_keys) !== JSON.stringify(event.answer_keys) ||
    answer.accepted_at.getTime() !== Date.parse(event.accepted_at)
  ) {
    throw new Error(`Event ${event.event_id} does not match its durable answer`)
  }

  return { ...answer, accepted_at: answer.accepted_at.toISOString() }
}
