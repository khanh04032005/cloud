const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
type Counter =
  "leases_acquired" | "leases_lost" | "rooms_recovered" | "rounds_closed"

export class Metrics {
  connections = 0
  ownedRooms = 0
  private readonly counters: Record<Counter, number> = {
    leases_acquired: 0,
    leases_lost: 0,
    rooms_recovered: 0,
    rounds_closed: 0,
  }
  private readonly latency = buckets.map(() => 0)
  private ackCount = 0
  private ackSum = 0

  increment(counter: Counter) {
    this.counters[counter] += 1
  }

  observeAck(seconds: number) {
    this.ackCount += 1
    this.ackSum += seconds
    buckets.forEach((limit, index) => {
      if (seconds <= limit) {
        this.latency[index] += 1
      }
    })
  }

  render() {
    const lines = [
      "# HELP razzia_connections Active authenticated Socket.IO connections.",
      "# TYPE razzia_connections gauge",
      `razzia_connections ${this.connections}`,
      "# HELP razzia_owned_rooms Rooms coordinated by this process.",
      "# TYPE razzia_owned_rooms gauge",
      `razzia_owned_rooms ${this.ownedRooms}`,
    ]
    for (const [name, value] of Object.entries(this.counters)) {
      lines.push(
        `# TYPE razzia_${name}_total counter`,
        `razzia_${name}_total ${value}`,
      )
    }
    lines.push(
      "# HELP razzia_answer_ack_seconds Time from gateway receipt until answer command completes.",
      "# TYPE razzia_answer_ack_seconds histogram",
    )
    buckets.forEach((limit, index) => {
      lines.push(
        `razzia_answer_ack_seconds_bucket{le="${limit}"} ${this.latency[index]}`,
      )
    })
    lines.push(
      `razzia_answer_ack_seconds_bucket{le="+Inf"} ${this.ackCount}`,
      `razzia_answer_ack_seconds_sum ${this.ackSum}`,
      `razzia_answer_ack_seconds_count ${this.ackCount}`,
    )

    return `${lines.join("\n")}\n`
  }
}

export const metrics = new Metrics()
