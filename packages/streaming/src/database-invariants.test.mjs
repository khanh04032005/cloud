import test from "node:test"
import { database } from "../test/database.mjs"
import { roomInvariants } from "../test/room-invariants.mjs"
import { roundAnswerInvariants } from "../test/round-answer-invariants.mjs"
import { scoringInvariants } from "../test/scoring-invariants.mjs"

test("database room invariants using the canonical migrations", async (t) => {
  const db = await database(t)
  await roomInvariants(t, db)
  await roundAnswerInvariants(t, db)
  await scoringInvariants(t, db)
})
