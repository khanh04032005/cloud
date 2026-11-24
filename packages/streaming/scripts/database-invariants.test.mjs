import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { migrate } from "../test/database.mjs"
import { roomInvariants } from "../test/room-invariants.mjs"
import { roundAnswerInvariants } from "../test/round-answer-invariants.mjs"
import { scoringInvariants } from "../test/scoring-invariants.mjs"

test(
  "room invariants on PostgreSQL with the canonical migrations",
  { timeout: 60000 },
  async (t) => {
    assert.ok(
      process.env.INTEGRATION_DATABASE_URL,
      "Set INTEGRATION_DATABASE_URL to an isolated test environment",
    )
    const db = new pg.Client({
      connectionString: process.env.INTEGRATION_DATABASE_URL,
    })
    const schema = `invariants_${randomUUID().replaceAll("-", "")}`
    await db.connect()
    try {
      await db.query(`CREATE SCHEMA ${schema}`)
      await db.query(`SET search_path TO ${schema}`)
      await migrate(db)
      await roomInvariants(t, db)
      await roundAnswerInvariants(t, db)
      await scoringInvariants(t, db)
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await db.end()
    }
  },
)
