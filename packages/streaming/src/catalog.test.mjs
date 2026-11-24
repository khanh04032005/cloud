import test from "node:test"
import assert from "node:assert/strict"
import { database, event, storeAnswer } from "../test/database.mjs"
import { applyScore } from "./score.mjs"
import {
  applyImportPlan,
  buildImportPlan,
} from "../../../role-d/lambda/import-questions/logic.mjs"
import {
  answersSql,
  assignRanks,
  hasScoreMismatch,
  resultsSql,
} from "../../../role-d/lambda/export-results/logic.mjs"

const source = {
  bucket: "test",
  key: "imports/quiz.json",
  etag: "v1",
  license: "CC BY-SA 4.0",
  body: Buffer.from(
    JSON.stringify({
      gameMode: "quiz",
      subject: "Imported quiz",
      questions: [
        {
          type: "single",
          question: "2+2?",
          answers: ["3", "4"],
          solutions: [1],
          cooldown: 3,
          time: 10,
          maxPoints: 1,
          media: { preserved: true },
        },
      ],
    }),
  ),
}

test("S3 import writes the playable catalog and deduplicates without orphan quizzes", async (t) => {
  const db = await database(t)
  const first = buildImportPlan(source)
  assert.equal((await applyImportPlan(db, first)).status, "imported")
  const query = await db.query(
    "SELECT q.subject, q.game_mode, s.position, s.definition FROM quizzes q JOIN questions s ON s.quiz_id = q.id WHERE q.id = $1",
    [first.quizId],
  )
  assert.equal(query.rows[0].position, 1)
  assert.equal(query.rows[0].game_mode, "quiz")
  assert.deepEqual(
    query.rows[0].definition,
    JSON.parse(source.body).questions[0],
  )
  assert.equal(
    (await applyImportPlan(db, buildImportPlan(source))).status,
    "duplicate",
  )
  assert.equal((await db.query("SELECT * FROM quizzes")).rows.length, 1)
  assert.equal(
    (await applyImportPlan(db, buildImportPlan({ ...source, etag: "v2" })))
      .status,
    "imported",
  )
  assert.equal((await db.query("SELECT * FROM quizzes")).rows.length, 2)
  assert.equal((await db.query("SELECT * FROM quiz_imports")).rows.length, 2)
})

test("import failure rolls back quiz, provenance and questions together", async (t) => {
  const db = await database(t)
  const plan = buildImportPlan(source)
  plan.statements[2].values[1] = "[null]"
  await assert.rejects(applyImportPlan(db, plan), /constraint/)
  assert.equal((await db.query("SELECT * FROM quizzes")).rows.length, 0)
  assert.equal((await db.query("SELECT * FROM quiz_imports")).rows.length, 0)
})

test("export and audit detect missing scores/markers/outbox and clear after scoring", async (t) => {
  const db = await database(t)
  const answer = event("00000000-0000-4000-8000-000000000001")
  await storeAnswer(db, answer)
  let scores = await db.query(resultsSql(answer.room_id).text, [answer.room_id])
  assert.equal(scores.rows[0].display_name, "Test player")
  assert.equal(scores.rows[0].missing_result, true)
  assert.equal(scores.rows[0].pending_score_events, 1)
  assert.equal(hasScoreMismatch(scores.rows[0]), true)
  const exported = await db.query(answersSql(answer.room_id).text, [
    answer.room_id,
  ])
  assert.equal(exported.rows[0].event_id, answer.event_id)
  assert.deepEqual(exported.rows[0].answer_keys, [1])
  await applyScore(db, answer)
  scores = await db.query(resultsSql(answer.room_id).text, [answer.room_id])
  assert.equal(scores.rows[0].points, 1)
  assert.equal(hasScoreMismatch(scores.rows[0]), false)
  await db.query("UPDATE results SET points = 2")
  assert.equal(
    hasScoreMismatch((await db.query("SELECT * FROM score_audit")).rows[0]),
    true,
  )
  await db.query("DELETE FROM outbox")
  assert.equal(
    (await db.query("SELECT missing_outbox FROM score_audit")).rows[0]
      .missing_outbox,
    1,
  )
})

test("all-room exports rank each room independently and include unanswered players", async (t) => {
  const db = await database(t)
  const rows = (await db.query(resultsSql(null).text)).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].points, 0)
  assert.equal(hasScoreMismatch(rows[0]), false)
  assert.deepEqual(
    assignRanks([
      { room_id: "b", player_id: "x", points: 0 },
      { room_id: "a", player_id: "x", points: 2 },
      { room_id: "a", player_id: "y", points: 2 },
      { room_id: "a", player_id: "z", points: 1 },
    ]).map(({ room_id, rank }) => [room_id, rank]),
    [
      ["a", 1],
      ["a", 1],
      ["a", 3],
      ["b", 1],
    ],
  )
})
