import test from "node:test"
import assert from "node:assert/strict"
import { BloomFilter } from "./bloom.mjs"
import { applyScore } from "./score.mjs"
import { applyStats } from "./stats.mjs"
import { publishBatch } from "./outbox.mjs"
import { parseAnswerEvent } from "./contract.mjs"
import {
  addRound,
  database,
  event,
  ids,
  storeAnswer,
} from "../test/database.mjs"

const firstId = "00000000-0000-4000-8000-000000000001"
const secondId = "00000000-0000-4000-8000-000000000002"

test("score replay uses A's results and marker, including wrong answers", async (t) => {
  const db = await database(t)
  const answer = event(firstId)
  await storeAnswer(db, answer)
  assert.equal((await applyScore(db, answer)).isNew, true)
  assert.equal((await applyScore(db, answer)).isNew, false)
  const wrong = event(secondId, {
    round_id: await addRound(db),
    is_correct: false,
  })
  await storeAnswer(db, wrong)
  await applyScore(db, wrong)
  assert.equal((await db.query("SELECT points FROM results")).rows[0].points, 1)
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM processed_answer_events"))
      .rows[0].n,
    2,
  )
})

test("failed score update rolls back its marker so a retry can succeed", async (t) => {
  const db = await database(t)
  const answer = event(firstId)
  await storeAnswer(db, answer)
  const failure = {
    query: (text, values) => {
      if (text.includes("INSERT INTO results")) {
        throw new Error("Injected score write failure")
      }
      return db.query(text, values)
    },
  }
  await assert.rejects(
    applyScore(failure, answer),
    /Injected score write failure/,
  )
  assert.equal(
    (await db.query("SELECT * FROM processed_answer_events")).rows.length,
    0,
  )
  assert.equal((await applyScore(db, answer)).isNew, true)
})

test("one-second stats bucket deduplicates after replay and Bloom restart", async (t) => {
  const db = await database(t)
  const uniques = new Set()
  const redis = { pfAdd: async (_key, value) => uniques.add(value) }
  const bloom = new BloomFilter()
  const first = event(firstId)
  const second = event(secondId, {
    round_id: await addRound(db),
    accepted_at: "2026-10-31T12:00:00.950Z",
  })
  await storeAnswer(db, first)
  await storeAnswer(db, second)
  assert.equal((await applyStats(db, redis, bloom, first)).isNew, true)
  assert.equal((await applyStats(db, redis, bloom, second)).isNew, true)
  assert.equal((await applyStats(db, redis, bloom, first)).isNew, false)
  assert.equal(
    (await applyStats(db, redis, new BloomFilter(), first)).isNew,
    false,
  )
  assert.equal(
    (await db.query("SELECT answer_count FROM answer_rate_buckets")).rows[0]
      .answer_count,
    2,
  )
  assert.equal(uniques.size, 1)
})

test("outbox joins durable answers, retains event identity after a failed send", async (t) => {
  const db = await database(t)
  const answer = event(firstId)
  await storeAnswer(db, answer)
  await assert.rejects(
    publishBatch(
      db,
      {
        send: async () => {
          throw new Error("broker unavailable")
        },
      },
      "answers",
    ),
    /broker unavailable/,
  )
  assert.equal(
    (await db.query("SELECT published_at FROM outbox")).rows[0].published_at,
    null,
  )
  const sent = []
  const producer = { send: async (message) => sent.push(message) }
  assert.equal(await publishBatch(db, producer, "answers"), 1)
  assert.equal(await publishBatch(db, producer, "answers"), 0)
  assert.equal(sent[0].acks, -1)
  assert.equal(sent[0].messages[0].key, ids.room)
  assert.deepEqual(JSON.parse(sent[0].messages[0].value), answer)
  assert.ok(
    (await db.query("SELECT published_at FROM outbox")).rows[0].published_at,
  )
  assert.equal(
    (
      await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'outbox' AND column_name IN ('room_id', 'payload')",
      )
    ).rows.length,
    0,
  )
})

test("a crash after broker ACK can republish the same event without double scoring", async (t) => {
  const db = await database(t)
  await storeAnswer(db, event(firstId))
  const sent = []
  const producer = { send: async ({ messages }) => sent.push(...messages) }
  const crash = {
    query: (text, values) => {
      if (text.startsWith("UPDATE outbox")) {
        throw new Error("lost transaction")
      }
      return db.query(text, values)
    },
  }
  await assert.rejects(
    publishBatch(crash, producer, "answers"),
    /lost transaction/,
  )
  await publishBatch(db, producer, "answers")
  assert.equal(sent.length, 2)
  assert.equal(sent[0].value, sent[1].value)
  for (const message of sent) {
    await applyScore(db, message.value)
  }
  assert.equal((await db.query("SELECT points FROM results")).rows[0].points, 1)
})

test("event contract supports A's single, multi and estimation answers", () => {
  for (const values of [
    { choice: 1, answer_keys: [1] },
    { choice: null, answer_keys: [0, 2] },
    { choice: null, answer_keys: [-1.5] },
  ]) {
    assert.deepEqual(
      parseAnswerEvent(event(firstId, values)).answer_keys,
      values.answer_keys,
    )
  }
  assert.throws(
    () => parseAnswerEvent(event(firstId, { choice: [1] })),
    /choice/,
  )
  assert.throws(
    () => parseAnswerEvent(event(firstId, { answer_keys: [NaN] })),
    /answer_keys/,
  )
  assert.throws(
    () => parseAnswerEvent(event(firstId, { room_id: "room-1" })),
    /room_id/,
  )
})
