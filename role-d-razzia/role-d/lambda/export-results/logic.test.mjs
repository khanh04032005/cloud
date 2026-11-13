import assert from "node:assert/strict"
import test from "node:test"
import { assignRanks, csvCell, resultsSql, toCsv } from "./logic.mjs"
import { buildImportPlan } from "../import-questions/logic.mjs"

test("ties share the earlier rank", () => {
  const ranked = assignRanks([
    { player_id: "c", points: 1 },
    { player_id: "a", points: 3 },
    { player_id: "b", points: 3 },
    { player_id: "d", points: 0 },
  ])

  assert.deepEqual(
    ranked.map((row) => [row.player_id, row.rank]),
    [
      ["a", 1],
      ["b", 1],
      ["c", 3],
      ["d", 4],
    ],
  )
})

test("csv escapes quotes and commas", () => {
  assert.equal(csvCell('a"b,c'), '"a""b,c"')
  assert.equal(toCsv(["name"], [{ name: "An, Bình" }]), 'name\n"An, Bình"\n')
})

test("import plan rejects a bad quiz and accepts a good one once", () => {
  const bad = buildImportPlan({
    bucket: "b",
    key: "imports/bad.json",
    etag: "1",
    body: Buffer.from("{"),
    license: "CC BY-SA 4.0",
  })
  assert.equal(bad.ok, false)

  const good = buildImportPlan({
    bucket: "b",
    key: "imports/ok.json",
    etag: "etag",
    license: "CC BY-SA 4.0",
    body: Buffer.from(
      JSON.stringify({
        gameMode: "quiz",
        subject: "Demo",
        questions: [
          {
            type: "single",
            question: "2 + 2?",
            answers: ["3", "4"],
            solutions: [1],
            cooldown: 3,
            time: 10,
            maxPoints: 1,
          },
        ],
      }),
    ),
  })

  assert.equal(good.ok, true)
  assert.equal(good.questionCount, 1)
  assert.equal(good.statements.length, 2)
  assert.match(good.sha256, /^[a-f0-9]{64}$/)
})

test("results query is scoped when a room is requested", () => {
  const scoped = resultsSql("room-1")
  assert.match(scoped.text, /ps\.room_id = \$1/)
  assert.deepEqual(scoped.values, ["room-1"])
  assert.equal(resultsSql(null).values.length, 0)
})
