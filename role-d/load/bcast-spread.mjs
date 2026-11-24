// Broadcast fan-out spread from k6 BCAST lines (player.js with BCAST_LOG=1).
// For each (event, question): lag_i = t_i - min(t). The first receiver stands in for
// the server's emit time, so this measures fan-out cost only, not base network latency.
// All VUs live in one k6 process, so they share a clock.
//
//   node load/bcast-spread.mjs ~/e01/bcast-100.log [--json]

import { readFile } from "node:fs/promises"

const LINE = /BCAST (\S+) (\d+) (\d+)/

export function parse(text) {
  const groups = new Map()
  const other = []

  for (const line of text.split("\n")) {
    const m = LINE.exec(line)

    if (!m) {
      if (line.trim()) other.push(line)
      continue
    }

    const key = `${m[1]}#${m[2]}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(Number(m[3]))
  }

  return { groups, other }
}

function pct(sorted, p) {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, i)]
}

export function summarize(groups) {
  const byEvent = new Map()

  for (const [key, times] of groups) {
    const event = key.split("#")[0]
    const first = Math.min(...times)
    const entry = byEvent.get(event) ?? { lags: [], spreads: [], receivers: [] }
    for (const t of times) entry.lags.push(t - first)
    entry.spreads.push(Math.max(...times) - first)
    entry.receivers.push(times.length)
    byEvent.set(event, entry)
  }

  const rows = []

  for (const [event, { lags, spreads, receivers }] of byEvent) {
    lags.sort((a, b) => a - b)
    spreads.sort((a, b) => a - b)
    rows.push({
      event,
      rounds: spreads.length,
      receivers_min: Math.min(...receivers),
      lag_p50: pct(lags, 50),
      lag_p95: pct(lags, 95),
      lag_p99: pct(lags, 99),
      spread_max: spreads.at(-1),
      spread_avg: Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length),
    })
  }

  return rows.sort((a, b) => a.event.localeCompare(b.event))
}

async function main() {
  const file = process.argv[2]

  if (!file) {
    console.error("usage: node load/bcast-spread.mjs <k6 console-output file> [--json]")
    process.exit(1)
  }

  const { groups, other } = parse(await readFile(file, "utf8"))

  if (groups.size === 0) {
    console.error("Không có dòng BCAST. Đã chạy k6 với BCAST_LOG=1 chưa?")
    process.exit(1)
  }

  const rows = summarize(groups)

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log("lag = thời gian nhận sau VU nhận sớm nhất (ms); spread = max lag của một lượt")
    console.table(rows)
  }

  if (other.length > 0) {
    console.error(`\n${other.length} dòng khác trong log (lỗi của VU?), 5 dòng đầu:`)
    for (const line of other.slice(0, 5)) console.error(`  ${line}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
