import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { answerFixture } from "./round-answer-invariants.mjs"
import { event, storeAnswer } from "./database.mjs"
import { applyScore } from "../src/score.mjs"

export async function scoringInvariants(t, db) {
  await t.test(
    "total score equals correct answers across rounds, independent of response time and maxPoints",
    async () => {
      const fixture = await answerFixture(db, "940000")
      const absentPlayer = randomUUID()
      await db.query(
        "INSERT INTO players (room_id, id, username) VALUES ($1, $2, 'No answers')",
        [fixture.roomId, absentPlayer],
      )
      const correctness = [true, false, true, true, false]
      const events = []
      for (const [index, correct] of correctness.entries()) {
        const roundId = fixture.rounds[index] ?? randomUUID()
        const definition = {
          type: "single",
          question: "One point?",
          answers: ["Wrong", "Correct"],
          solutions: [1],
          time: 60,
          cooldown: 3,
          maxPoints: [0, 1, 1000][index % 3],
        }
        const closesAt = new Date(
          Date.parse("2026-10-31T12:01:00Z") + index * 60000,
        )
        if (index < fixture.rounds.length) {
          await db.query(
            "UPDATE rounds SET question_snapshot = $2, closes_at = $3 WHERE id = $1",
            [roundId, JSON.stringify(definition), closesAt],
          )
        } else {
          await db.query(
            "INSERT INTO rounds (id, room_id, position, question_snapshot, closes_at) VALUES ($1, $2, $3, $4, $5)",
            [
              roundId,
              fixture.roomId,
              index + 1,
              JSON.stringify(definition),
              closesAt,
            ],
          )
        }
        for (const [playerIndex, playerId] of fixture.players.entries()) {
          const isCorrect = playerIndex === 0 && correct
          const acceptedAt = new Date(
            closesAt.getTime() - (index % 2 === 0 ? 1 : 59000),
          ).toISOString()
          const answer = event(randomUUID(), {
            room_id: fixture.roomId,
            round_id: roundId,
            player_id: playerId,
            choice: isCorrect ? 1 : 0,
            answer_keys: [isCorrect ? 1 : 0],
            is_correct: isCorrect,
            accepted_at: acceptedAt,
          })
          await storeAnswer(db, answer)
          events.push(answer)
        }
      }
      for (const answer of events) {
        assert.equal((await applyScore(db, answer)).isNew, true)
      }
      const scored = async () =>
        (
          await db.query(
            "SELECT player_id, points FROM results WHERE room_id = $1 ORDER BY player_id",
            [fixture.roomId],
          )
        ).rows
      const original = await scored()
      assert.equal(
        original.find(({ player_id }) => player_id === fixture.players[0])
          .points,
        3,
      )
      assert.equal(
        original.find(({ player_id }) => player_id === fixture.players[1])
          .points,
        0,
      )
      const audit = (
        await db.query("SELECT * FROM score_audit WHERE room_id = $1", [
          fixture.roomId,
        ])
      ).rows
      assert.equal(audit.length, 3)
      assert.ok(
        audit.every(
          ({
            point_delta,
            missing_result,
            missing_outbox,
            pending_score_events,
          }) =>
            point_delta === 0 &&
            !missing_result &&
            missing_outbox === 0 &&
            pending_score_events === 0,
        ),
      )
      assert.equal(
        audit.find(({ player_id }) => player_id === absentPlayer).stored_points,
        0,
      )
      for (const replay of [
        [...events].reverse(),
        events,
        [...events].reverse(),
      ]) {
        for (const answer of replay) {
          assert.equal((await applyScore(db, answer)).isNew, false)
        }
        assert.deepEqual(await scored(), original)
      }
      const markers = await db.query(
        "SELECT count(*)::int AS n FROM processed_answer_events WHERE event_id = ANY($1::uuid[])",
        [events.map(({ event_id }) => event_id)],
      )
      assert.equal(markers.rows[0].n, 10)
    },
  )
}
