import { readdir, readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { randomUUID } from "node:crypto"

export const ids = {
  room: "10000000-0000-4000-8000-000000000001",
  player: "20000000-0000-4000-8000-000000000001",
  round: "30000000-0000-4000-8000-000000000001",
}
export const event = (id, overrides = {}) => ({
  event_id: id,
  room_id: ids.room,
  round_id: ids.round,
  player_id: ids.player,
  choice: 1,
  answer_keys: [1],
  is_correct: true,
  accepted_at: "2026-10-31T12:00:00.250Z",
  ...overrides,
})

export async function migrate(db) {
  const dir = new URL("../../socket/migrations/", import.meta.url)
  for (const filename of (await readdir(dir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new URL(filename, dir), "utf8")
    if (db.exec) {
      await db.exec(sql)
    } else {
      await db.query(sql)
    }
  }
}

export async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await migrate(db)
  await db.query(
    "INSERT INTO rooms (id, invite_code, host_client_id, subject) VALUES ($1, '123456', $2, 'Test')",
    [ids.room, ids.player],
  )
  await db.query(
    "INSERT INTO players (room_id, id, username) VALUES ($1, $2, 'Test player')",
    [ids.room, ids.player],
  )
  await db.query(
    "INSERT INTO rounds (id, room_id, position, question_snapshot) VALUES ($1, $2, 1, '{}')",
    [ids.round, ids.room],
  )
  return db
}

export async function addRound(db, position = 2) {
  const roundId = randomUUID()
  await db.query(
    "INSERT INTO rounds (id, room_id, position, question_snapshot) VALUES ($1, $2, $3, '{}')",
    [roundId, ids.room, position],
  )
  return roundId
}

export async function storeAnswer(db, answer) {
  await db.query(
    `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct, accepted_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      answer.room_id,
      answer.round_id,
      answer.player_id,
      answer.choice,
      JSON.stringify(answer.answer_keys),
      answer.is_correct,
      answer.accepted_at,
    ],
  )
  await db.query(
    "INSERT INTO outbox (event_id, round_id, player_id) VALUES ($1, $2, $3)",
    [answer.event_id, answer.round_id, answer.player_id],
  )
}
