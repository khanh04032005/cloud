import { kafka } from "../src/runtime.mjs"
import { config } from "../src/config.mjs"

const admin = kafka.admin()

try {
  await admin.connect()
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic: config.topic, numPartitions: 3, replicationFactor: 1 }],
  })
  console.log(`Topic ${config.topic} is ready with 3 partitions`)
} finally {
  await admin.disconnect()
}
