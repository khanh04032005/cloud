import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { event, storeAnswer } from "./database.mjs"

export async function answerFixture(db, inviteCode) {
  const fixture = {
    roomId: randomUUID(),
    players: [randomUUID(), randomUUID()],
    rounds: [randomUUID(), randomUUID()],
  }
  await db.query(
    "INSERT INTO rooms (id, invite_code, host_client_id, subject) VALUES ($1, $2, $3, 'One answer per round')",
    [fixture.roomId, inviteCode, randomUUID()],
  )
  for (const playerId of fixture.players) {
    await db.query(
      "INSERT INTO players (room_id, id, username) VALUES ($1, $2, 'Player')",
      [fixture.roomId, playerId],
    )
  }
  for (const [position, roundId] of fixture.rounds.entries()) {
    await db.query(
      "INSERT INTO rounds (id, room_id, position, question_snapshot) VALUES ($1, $2, $3, '{}')",
      [roundId, fixture.roomId, position + 1],
    )
  }
  fixture.answer = event(randomUUID(), {
    room_id: fixture.roomId,
    round_id: fixture.rounds[0],
    player_id: fixture.players[0],
  })
  return fixture
}

async function rowsFor(db, roomId) {
  return {
    answers: (
      await db.query(
        "SELECT * FROM answers WHERE room_id = $1 ORDER BY round_id, player_id",
        [roomId],
      )
    ).rows,
    outbox: (
      await db.query(
        "SELECT o.* FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = $1 ORDER BY o.round_id, o.player_id",
        [roomId],
      )
    ).rows,
  }
}

export async function roundAnswerInvariants(t, db) {
  await t.test(
    "same and changed choices cannot create a second answer for a round/player",
    async () => {
      const { answer, roomId } = await answerFixture(db, "920000")
      await storeAnswer(db, answer)
      const original = await rowsFor(db, roomId)
      for (const choice of [answer.choice, 0]) {
        await assert.rejects(
          db.query(
            `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
        VALUES ($1, $2, $3, $4, $5::jsonb, false)`,
            [
              roomId,
              answer.round_id,
              answer.player_id,
              choice,
              JSON.stringify([choice]),
            ],
          ),
          (error) => error.code === "23505",
        )
        assert.deepEqual(await rowsFor(db, roomId), original)
      }
      assert.equal(original.answers.length, 1)
      assert.equal(original.outbox.length, 1)
    },
  )

  await t.test(
    "64 conflict retries preserve the first choice, correctness, timestamp and outbox identity",
    async () => {
      const { answer, roomId } = await answerFixture(db, "920001")
      await storeAnswer(db, answer)
      const original = await rowsFor(db, roomId)
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const retry = await db.query(
          `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct, accepted_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, false, clock_timestamp())
        ON CONFLICT (round_id, player_id) DO NOTHING RETURNING *`,
          [
            roomId,
            answer.round_id,
            answer.player_id,
            attempt % 2,
            JSON.stringify([attempt % 2]),
          ],
        )
        assert.equal(retry.rows.length, 0)
      }
      assert.deepEqual(await rowsFor(db, roomId), original)
    },
  )

  await t.test(
    "the same player can answer the next round without changing their previous answer",
    async () => {
      const { answer, roomId, rounds } = await answerFixture(db, "920002")
      await storeAnswer(db, answer)
      const original = (await rowsFor(db, roomId)).answers[0]
      await storeAnswer(db, {
        ...answer,
        event_id: randomUUID(),
        round_id: rounds[1],
        choice: 0,
        answer_keys: [0],
        is_correct: false,
      })
      const stored = await rowsFor(db, roomId)
      assert.equal(stored.answers.length, 2)
      assert.equal(stored.outbox.length, 2)
      assert.deepEqual(
        stored.answers.find(({ round_id }) => round_id === answer.round_id),
        original,
      )
      const counts = await db.query(
        "SELECT round_id, player_id, count(*)::int AS n FROM answers WHERE room_id = $1 GROUP BY round_id, player_id",
        [roomId],
      )
      assert.ok(counts.rows.every(({ n }) => n === 1))
      assert.equal(counts.rows.length, 2)
    },
  )

  await t.test(
    "different players can each answer the same round exactly once",
    async () => {
      const { answer, roomId, players } = await answerFixture(db, "920003")
      await storeAnswer(db, answer)
      await storeAnswer(db, {
        ...answer,
        event_id: randomUUID(),
        player_id: players[1],
        choice: 0,
        answer_keys: [0],
        is_correct: false,
      })
      const stored = await rowsFor(db, roomId)
      assert.equal(stored.answers.length, 2)
      assert.equal(stored.outbox.length, 2)
      assert.equal(
        new Set(stored.answers.map(({ player_id }) => player_id)).size,
        2,
      )
      assert.ok(
        stored.answers.every(({ round_id }) => round_id === answer.round_id),
      )
    },
  )

  await t.test(
    "UPDATE cannot merge two answers onto the same round/player key",
    async () => {
      const { answer, roomId, rounds, players } = await answerFixture(
        db,
        "920004",
      )
      await storeAnswer(db, answer)
      // No outbox references these rows, so the errors prove answer uniqueness itself.
      await db.query(
        `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
      VALUES ($1, $2, $3, 0, '[0]', false), ($1, $4, $5, 0, '[0]', false)`,
        [roomId, rounds[1], players[0], rounds[0], players[1]],
      )
      const original = await rowsFor(db, roomId)
      await assert.rejects(
        db.query(
          "UPDATE answers SET round_id = $1 WHERE round_id = $2 AND player_id = $3",
          [rounds[0], rounds[1], players[0]],
        ),
        (error) => error.code === "23505",
      )
      await assert.rejects(
        db.query(
          "UPDATE answers SET player_id = $1 WHERE round_id = $2 AND player_id = $3",
          [players[0], rounds[0], players[1]],
        ),
        (error) => error.code === "23505",
      )
      assert.deepEqual(await rowsFor(db, roomId), original)
    },
  )

  await t.test(
    "multiple selected options still form a single answer for that round",
    async () => {
      const fixture = await answerFixture(db, "920005")
      const answer = { ...fixture.answer, choice: null, answer_keys: [0, 2] }
      await storeAnswer(db, answer)
      const original = await rowsFor(db, fixture.roomId)
      await assert.rejects(
        db.query(
          `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct)
      VALUES ($1, $2, $3, NULL, '[1,2]', false)`,
          [answer.room_id, answer.round_id, answer.player_id],
        ),
        (error) => error.code === "23505",
      )
      assert.deepEqual(await rowsFor(db, fixture.roomId), original)
      assert.deepEqual(original.answers[0].answer_keys, [0, 2])
      assert.equal(original.answers.length, 1)
      assert.equal(original.outbox.length, 1)
    },
  )
}
