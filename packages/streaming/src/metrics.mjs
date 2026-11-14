import http from "node:http"

const counters = new Map()
const gauges = new Map()

export function inc(name, amount = 1) {
  counters.set(name, Number(counters.get(name) ?? 0) + amount)
}

export function setGauge(name, value) {
  gauges.set(name, value)
}

export function startMetrics(port) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end()

      return
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4")
    const lines = [
      ...[...counters].map(([key, value]) => `${key} ${value}`),
      ...[...gauges].map(([key, value]) => `${key} ${value}`),
    ]
    res.end(`${lines.join("\n")}\n`)
  })
  server.listen(port)

  return server
}
