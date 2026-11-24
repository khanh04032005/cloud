import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { applyScore } from "../src/score.mjs"
import { applyStats } from "../src/stats.mjs"
import { BloomFilter } from "../src/bloom.mjs"
import { publishBatch } from "../src/outbox.mjs"
import { event, storeAnswer } from "./database.mjs"
import { readExportSnapshot } from "../../../role-d/lambda/export-results/logic.mjs"

// Runs unchanged against both PGlite and an isolated PostgreSQL schema.
export async function roomInvariants(t, db) {
  const sharedPlayer = randomUUID()
  const rooms = []
  for (let index = 0; index < 3; index += 1) {
    const room = {
      id: randomUUID(),
      player: randomUUID(),
      rounds: [randomUUID(), randomUUID()],
    }
    await db.query(
      "INSERT INTO rooms (id, invite_code, host_client_id, subject) VALUES ($1, $2, $3, 'Isolation test')",
      [room.id, String(910000 + index), randomUUID()],
    )
    for (const player of [room.player, sharedPlayer]) {
      await db.query(
        "INSERT INTO players (room_id, id, username) VALUES ($1, $2, $3)",
        [
          room.id,
          player,
          player === sharedPlayer ? `Shared ${index}` : `Only ${index}`,
        ],
      )
    }
    for (const [indexInRoom, roundId] of room.rounds.entries()) {
      await db.query(
        "INSERT INTO rounds (id, room_id, position, question_snapshot) VALUES ($1, $2, $3, '{}')",
        [roundId, room.id, indexInRoom + 1],
      )
    }
    room.answer = event(randomUUID(), {
      room_id: room.id,
      player_id: sharedPlayer,
      round_id: room.rounds[0],
      is_correct: index !== 1,
    })
    await storeAnswer(db, room.answer)
    rooms.push(room)
  }
  const [first, second, third] = rooms
  const roomIds = rooms.map(({ id }) => id)
  const snapshot = async () => {
    const state = {}
    for (const table of [
      "answers",
      "results",
      "answer_rate_buckets",
      "processed_answer_events",
      "stats_processed_events",
      "outbox",
    ]) {
      // Table names are a fixed allowlist, never supplied by a client.
      state[table] = (
        await db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)
      ).rows
    }
    return state
  }
  const rejectStatement = async (text, values, code) => {
    const before = await snapshot()
    await assert.rejects(db.query(text, values), (error) => error.code === code)
    assert.deepEqual(
      await snapshot(),
      before,
      "A rejected write must not change any durable answer, score, outbox or marker",
    )
  }

  await t.test(
    "answers reject every foreign room/round combination even for the same player in all rooms",
    async () => {
      for (const room of rooms) {
        for (const owner of rooms) {
          if (room.id === owner.id) {
            continue
          }
          await rejectStatement(
            `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
          VALUES ($1, $2, $3, 0, '[0]', true)`,
            [room.id, owner.rounds[1], sharedPlayer],
            "23503",
          )
        }
      }
    },
  )

  await t.test(
    "answers reject valid player IDs whose membership belongs to another room",
    async () => {
      for (const room of rooms) {
        for (const owner of rooms) {
          if (room.id === owner.id) {
            continue
          }
          await rejectStatement(
            `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
          VALUES ($1, $2, $3, 0, '[0]', true)`,
            [room.id, room.rounds[1], owner.player],
            "23503",
          )
        }
      }
    },
  )

  await t.test(
    "UPDATE cannot detach an answer from its room, round or membership",
    async () => {
      for (const [column, value] of [
        ["room_id", second.id],
        ["round_id", second.rounds[1]],
        ["player_id", second.player],
      ]) {
        await rejectStatement(
          `UPDATE answers SET ${column} = $1 WHERE round_id = $2 AND player_id = $3`,
          [value, first.rounds[0], sharedPlayer],
          "23503",
        )
      }
      // A multi-row UPDATE also rolls back the rows it touched before a constraint failure.
      await rejectStatement(
        "UPDATE answers SET room_id = $1 WHERE room_id = ANY($2::uuid[])",
        [second.id, [first.id, third.id]],
        "23503",
      )
    },
  )

  await t.test(
    "results require a player membership in the destination room on INSERT and UPDATE",
    async () => {
      await db.query(
        "INSERT INTO results (room_id, player_id, points) VALUES ($1, $2, 0)",
        [first.id, first.player],
      )
      await rejectStatement(
        "INSERT INTO results (room_id, player_id, points) VALUES ($1, $2, 5)",
        [first.id, second.player],
        "23503",
      )
      await rejectStatement(
        "UPDATE results SET room_id = $1 WHERE room_id = $2 AND player_id = $3",
        [second.id, first.id, first.player],
        "23503",
      )
    },
  )

  await t.test(
    "outbox cannot combine a round and player without that exact accepted answer",
    async () => {
      await rejectStatement(
        "INSERT INTO outbox (event_id, round_id, player_id) VALUES ($1, $2, $3)",
        [randomUUID(), first.rounds[0], second.player],
        "23503",
      )
      await rejectStatement(
        "UPDATE outbox SET round_id = $1 WHERE event_id = $2",
        [second.rounds[1], first.answer.event_id],
        "23503",
      )
    },
  )

  await t.test(
    "one answer and one outbox event per round/player, with retries preserving the original",
    async () => {
      await rejectStatement(
        `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
      VALUES ($1, $2, $3, 0, '[0]', false)`,
        [first.id, first.rounds[0], sharedPlayer],
        "23505",
      )
      await rejectStatement(
        "INSERT INTO outbox (event_id, round_id, player_id) VALUES ($1, $2, $3)",
        [randomUUID(), first.rounds[0], sharedPlayer],
        "23505",
      )
    },
  )

  await t.test("open-round uniqueness is local to each room", async () => {
    await db.query(
      "UPDATE rounds SET status = 'open' WHERE id = ANY($1::uuid[])",
      [rooms.map(({ rounds }) => rounds[0])],
    )
    await assert.rejects(
      db.query("UPDATE rounds SET status = 'open' WHERE id = $1", [
        first.rounds[1],
      ]),
      (error) => error.code === "23505",
    )
    assert.equal(
      (
        await db.query(
          "SELECT * FROM rounds WHERE room_id = ANY($1::uuid[]) AND status = 'open'",
          [roomIds],
        )
      ).rows.length,
      3,
    )
  })

  await t.test(
    "CHECK constraints reject negative scores/counts, malformed answer keys and inconsistent finished state",
    async () => {
      await rejectStatement(
        "UPDATE results SET points = -1 WHERE room_id = $1",
        [first.id],
        "23514",
      )
      await rejectStatement(
        "INSERT INTO answer_rate_buckets (room_id, bucket_start, answer_count) VALUES ($1, now(), -1)",
        [first.id],
        "23514",
      )
      await rejectStatement(
        "UPDATE answers SET answer_keys = '{}' WHERE room_id = $1",
        [first.id],
        "23514",
      )
      await assert.rejects(
        db.query("UPDATE rooms SET status = 'finished' WHERE id = $1", [
          first.id,
        ]),
        (error) => error.code === "23514",
      )
      await assert.rejects(
        db.query("UPDATE rooms SET finished_at = now() WHERE id = $1", [
          first.id,
        ]),
        (error) => error.code === "23514",
      )
      assert.equal(
        (await db.query("SELECT status FROM rooms WHERE id = $1", [first.id]))
          .rows[0].status,
        "lobby",
      )
    },
  )

  await t.test(
    "score worker rejects forged routing and contents before writing any marker or score",
    async () => {
      for (const overrides of [
        { room_id: second.id },
        { room_id: second.id, round_id: second.rounds[0] },
        { player_id: first.player },
        { is_correct: false },
        { choice: 0, answer_keys: [0] },
        { accepted_at: "2026-10-31T13:00:00.000Z" },
        { event_id: randomUUID() },
      ]) {
        const before = await snapshot()
        await assert.rejects(
          applyScore(db, { ...first.answer, ...overrides }),
          /durable answer/,
        )
        assert.deepEqual(await snapshot(), before)
      }
    },
  )

  await t.test(
    "stats worker rejects forged room/time before touching buckets, markers or Redis",
    async () => {
      for (const mode of ["bloom", "db"]) {
        for (const overrides of [
          { room_id: second.id },
          { room_id: second.id, round_id: second.rounds[0] },
          { accepted_at: "2026-10-31T13:00:00.000Z" },
          { event_id: randomUUID() },
        ]) {
          const redisWrites = []
          const redis = { pfAdd: async (...args) => redisWrites.push(args) }
          const before = await snapshot()
          await assert.rejects(
            applyStats(
              db,
              redis,
              new BloomFilter(),
              { ...first.answer, ...overrides },
              mode,
            ),
            /durable answer/,
          )
          assert.deepEqual(await snapshot(), before)
          assert.deepEqual(redisWrites, [])
        }
      }
    },
  )

  await t.test(
    "one client in multiple rooms gets independent scores, stats and export snapshots",
    async () => {
      const redisWrites = []
      const redis = { pfAdd: async (...args) => redisWrites.push(args) }
      const bloom = new BloomFilter()
      for (const room of rooms) {
        assert.equal((await applyScore(db, room.answer)).isNew, true)
        assert.equal(
          (await applyStats(db, redis, bloom, room.answer)).isNew,
          true,
        )
      }
      for (const room of rooms) {
        const exported = await readExportSnapshot(db, room.id)
        assert.ok(exported.scores.every(({ room_id }) => room_id === room.id))
        assert.equal(
          exported.scores.find(({ player_id }) => player_id === sharedPlayer)
            .points,
          room.answer.is_correct ? 1 : 0,
        )
        assert.equal(exported.answers.length, 1)
        assert.equal(exported.answers[0].event_id, room.answer.event_id)
        assert.equal(
          (
            await db.query(
              "SELECT answer_count FROM answer_rate_buckets WHERE room_id = $1",
              [room.id],
            )
          ).rows[0].answer_count,
          1,
        )
        assert.ok(
          redisWrites.some(
            ([key, playerId]) =>
              key === `razzia:unique:${room.id}` && playerId === sharedPlayer,
          ),
        )
      }
    },
  )

  await t.test(
    "forged duplicates cannot reroute score or Redis writes through a dedup fast path",
    async () => {
      for (const mode of ["bloom", "db"]) {
        const bloom = new BloomFilter()
        bloom.add(first.answer.event_id)
        const redisWrites = []
        const redis = { pfAdd: async (...args) => redisWrites.push(args) }
        const before = await snapshot()
        await assert.rejects(
          applyScore(db, { ...first.answer, room_id: second.id }),
          /durable answer/,
        )
        await assert.rejects(
          applyStats(
            db,
            redis,
            bloom,
            { ...first.answer, room_id: second.id },
            mode,
          ),
          /durable answer/,
        )
        assert.deepEqual(await snapshot(), before)
        assert.deepEqual(redisWrites, [])
        assert.equal((await applyScore(db, first.answer)).isNew, false)
        assert.equal(
          (await applyStats(db, redis, bloom, first.answer, mode)).isNew,
          false,
        )
        assert.deepEqual(redisWrites, [
          [`razzia:unique:${first.id}`, sharedPlayer],
        ])
      }
    },
  )

  await t.test(
    "publisher derives every Kafka room key and payload from the corresponding durable answer",
    async () => {
      const sent = []
      await publishBatch(
        db,
        { send: async ({ messages }) => sent.push(...messages) },
        "answers",
      )
      for (const room of rooms) {
        const message = sent.find(
          ({ value }) => JSON.parse(value).event_id === room.answer.event_id,
        )
        assert.ok(message)
        assert.equal(message.key, room.id)
        assert.deepEqual(JSON.parse(message.value), room.answer)
      }
    },
  )
}
