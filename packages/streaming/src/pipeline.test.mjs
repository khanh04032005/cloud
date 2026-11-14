import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { BloomFilter } from "./bloom.mjs"
import { applyScore } from "./score.mjs"
import { applyStats } from "./stats.mjs"
import { publishBatch } from "./outbox.mjs"

const schema = await readFile(
  new URL("../db/001_streaming.sql", import.meta.url),
  "utf8",
)
const devOutbox = await readFile(
  new URL("../db/002_dev_outbox.sql", import.meta.url),
  "utf8",
)

const event = (id, time = "2026-10-31T12:00:00.250Z", correct = true) => ({
  event_id: id,
  room_id: "room-1",
  round_id: "round-1",
  player_id: "player-1",
  choice: [1],
  is_correct: correct,
  accepted_at: time,
})

test("score replay does not award a correct answer twice", async () => {
  const db = new PGlite()
  await db.exec(schema)
  const answer = event("00000000-0000-4000-8000-000000000001")
  assert.equal((await applyScore(db, answer)).isNew, true)
  assert.equal((await applyScore(db, answer)).isNew, false)
  const wrong = event("00000000-0000-4000-8000-000000000002", undefined, false)
  await applyScore(db, wrong)
  const { rows } = await db.query(
    "SELECT points FROM player_scores WHERE room_id = $1",
    ["room-1"],
  )
  assert.equal(rows[0].points, 1)
  await db.close()
})

test("one-second bucket counts unique accepted events across replay", async () => {
  const db = new PGlite()
  await db.exec(schema)
  const uniques = new Set()
  const redis = { pfAdd: async (_key, value) => uniques.add(value) }
  const bloom = new BloomFilter()
  const first = event("00000000-0000-4000-8000-000000000003")
  const second = event(
    "00000000-0000-4000-8000-000000000004",
    "2026-10-31T12:00:00.950Z",
  )
  assert.equal((await applyStats(db, redis, bloom, first)).isNew, true)
  assert.equal((await applyStats(db, redis, bloom, second)).isNew, true)
  assert.equal((await applyStats(db, redis, bloom, first)).isNew, false)
  const { rows } = await db.query(
    "SELECT answer_count, bucket_start FROM answer_rate_buckets",
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].answer_count, 2)
  assert.equal(uniques.size, 1)
  await db.close()
})

test("a restarted Bloom filter still relies on the database unique constraint", async () => {
  const db = new PGlite()
  await db.exec(schema)
  const redis = { pfAdd: async () => {} }
  const answer = event("00000000-0000-4000-8000-000000000005")
  await applyStats(db, redis, new BloomFilter(), answer)
  const result = await applyStats(db, redis, new BloomFilter(), answer)
  assert.equal(result.isNew, false)
  const { rows } = await db.query(
    "SELECT answer_count FROM answer_rate_buckets",
  )
  assert.equal(rows[0].answer_count, 1)
  await db.close()
})

test("outbox publisher uses room key and retries an uncommitted send", async () => {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(devOutbox)
  const answer = event("00000000-0000-4000-8000-000000000006")
  await db.query(
    "INSERT INTO outbox (event_id, room_id, payload) VALUES ($1, $2, $3)",
    [answer.event_id, answer.room_id, JSON.stringify(answer)],
  )
  const second = event("00000000-0000-4000-8000-000000000007")
  await db.query(
    "INSERT INTO outbox (event_id, room_id, payload) VALUES ($1, $2, $3)",
    [second.event_id, second.room_id, JSON.stringify(second)],
  )
  const failing = {
    send: async () => {
      throw new Error("broker unavailable")
    },
  }
  await assert.rejects(
    publishBatch(db, failing, "answers"),
    /broker unavailable/,
  )
  const before = await db.query("SELECT published_at FROM outbox")
  assert.equal(before.rows.filter((row) => row.published_at === null).length, 2)
  const sent = []
  const producer = { send: async (message) => sent.push(message) }
  assert.equal(await publishBatch(db, producer, "answers"), 2)
  assert.equal(await publishBatch(db, producer, "answers"), 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].messages[0].key, "room-1")
  assert.equal(sent[0].messages.length, 2)
  const after = await db.query("SELECT published_at FROM outbox")
  assert.equal(after.rows.filter((row) => row.published_at !== null).length, 2)
  await db.close()
})
