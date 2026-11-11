import { expect, it } from "vitest"
import { Metrics } from "@razzia/socket/services/metrics"

it("exports cumulative ACK buckets and gauges without per-player labels", () => {
  const metrics = new Metrics()
  metrics.connections = 2
  metrics.ownedRooms = 1
  metrics.increment("rooms_recovered")
  metrics.observeAck(0.006)
  metrics.observeAck(0.2)
  const output = metrics.render()
  expect(output).toContain("razzia_connections 2\n")
  expect(output).toContain("razzia_owned_rooms 1\n")
  expect(output).toContain("razzia_rooms_recovered_total 1\n")
  expect(output).toContain('razzia_answer_ack_seconds_bucket{le="0.005"} 0\n')
  expect(output).toContain('razzia_answer_ack_seconds_bucket{le="0.01"} 1\n')
  expect(output).toContain('razzia_answer_ack_seconds_bucket{le="0.25"} 2\n')
  expect(output).toContain('razzia_answer_ack_seconds_bucket{le="+Inf"} 2\n')
  expect(output).toContain("razzia_answer_ack_seconds_count 2\n")
  expect(output).toContain("razzia_answer_ack_seconds_sum 0.206")
  expect(output).not.toMatch(/room_id|player_id/)
})
