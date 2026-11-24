import { readFile, writeFile } from "node:fs/promises"
import { kafka, pool } from "../src/runtime.mjs"
import { config } from "../src/config.mjs"

const baselineFile = new URL("../.replay-baseline.json", import.meta.url)
const command = process.argv[2]
const admin = kafka.admin()

async function snapshot() {
  const scores = await pool.query(
    "SELECT room_id, player_id, points FROM results ORDER BY room_id, player_id",
  )
  const rates = await pool.query(
    "SELECT room_id, bucket_start, answer_count FROM answer_rate_buckets ORDER BY room_id, bucket_start",
  )

  return { scores: scores.rows, rates: rates.rows }
}

try {
  if (command === "reset") {
    const before = await snapshot()
    await writeFile(baselineFile, JSON.stringify(before, null, 2))
    await admin.connect()
    for (const groupId of ["razzia-score", "razzia-stats"]) {
      await admin.resetOffsets({ groupId, topic: config.topic, earliest: true })
    }
    console.log(
      "Offsets reset. Restart both workers, wait for lag 0, then run: node scripts/replay.mjs verify",
    )
    console.log("Baseline:", before)
  } else if (command === "verify") {
    const before = JSON.parse(await readFile(baselineFile, "utf8"))
    const after = await snapshot()

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(
        `Replay changed stored rows: ${JSON.stringify({ before, after })}`,
      )
    }

    console.log("Replay idempotence verified:", after)
  } else {
    throw new Error("Usage: node scripts/replay.mjs reset|verify")
  }
} finally {
  await admin.disconnect().catch(() => {})
  await pool.end()
}
