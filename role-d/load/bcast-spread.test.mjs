import { test } from "node:test"
import assert from "node:assert/strict"
import { parse, summarize } from "./bcast-spread.mjs"

const log = `
time="x" level=info msg="BCAST SELECT_ANSWER 1 1000" source=console
time="x" level=info msg="BCAST SELECT_ANSWER 1 1004" source=console
time="x" level=info msg="BCAST SELECT_ANSWER 2 5000" source=console
time="x" level=info msg="BCAST SELECT_ANSWER 2 5010" source=console
time="x" level=info msg="BCAST SHOW_RESULT 1 2000" source=console
time="x" level=info msg="BCAST SHOW_RESULT 1 2050" source=console
time="x" level=error msg="ws boom" source=console
`

test("groups by event and question, lag is relative to first receiver", () => {
  const { groups, other } = parse(log)
  assert.deepEqual(groups.get("SELECT_ANSWER#1"), [1000, 1004])
  assert.equal(other.length, 1)

  const rows = summarize(groups)
  const select = rows.find((r) => r.event === "SELECT_ANSWER")
  assert.equal(select.rounds, 2)
  assert.equal(select.spread_max, 10)
  assert.equal(select.spread_avg, 7)
  assert.equal(select.lag_p50, 0)

  const result = rows.find((r) => r.event === "SHOW_RESULT")
  assert.equal(result.spread_max, 50)
})
