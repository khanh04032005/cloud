import { randomUUID } from "node:crypto"
import { pool } from "../src/runtime.mjs"

const [roomId = "demo-room", playerId = "demo-player", correctArg = "true"] =
  process.argv.slice(2)

if (!["true", "false"].includes(correctArg)) {
  throw new Error(
    "Usage: node scripts/seed-answer.mjs [room_id] [player_id] [true|false]",
  )
}

const answer = {
  event_id: randomUUID(),
  room_id: roomId,
  round_id: randomUUID(),
  player_id: playerId,
  choice: [1],
  is_correct: correctArg === "true",
  accepted_at: new Date().toISOString(),
}

try {
  await pool.query(
    "INSERT INTO outbox (event_id, room_id, payload) VALUES ($1, $2, $3)",
    [answer.event_id, roomId, JSON.stringify(answer)],
  )
  console.log(answer)
} finally {
  await pool.end()
}
