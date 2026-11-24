import { randomUUID } from "node:crypto"
import type { Cloud } from "@razzia/socket/services/cloud"
import { CloudGame } from "@razzia/socket/services/cloud-game"
import { acquireLocked } from "@razzia/socket/services/leases"

export const ownedRoom = async (storage: Cloud) => {
  const roomId = randomUUID()
  const roundId = randomUUID()
  const playerId = randomUUID()
  const socketId = randomUUID()
  const hostId = randomUUID()
  const question = {
    type: "single",
    question: "Test?",
    answers: ["Correct", "Wrong"],
    solutions: [0],
    time: 30,
    cooldown: 3,
  }
  const lease = await storage.transaction(async (client) => {
    await client.query(
      "INSERT INTO rooms (id, invite_code, host_client_id, subject, status, current_position) VALUES ($1, $2, $3, 'Answer test', 'running', 1)",
      [
        roomId,
        String(Math.floor(Math.random() * 1000000)).padStart(6, "0"),
        hostId,
      ],
    )
    await client.query(
      "INSERT INTO rounds (id, room_id, position, question_snapshot, status, closes_at) VALUES ($1, $2, 1, $3, 'open', clock_timestamp() + interval '1 minute')",
      [roundId, roomId, question],
    )
    await client.query(
      "INSERT INTO players (room_id, id, username, socket_id, connected) VALUES ($1, $2, 'Test player', $3, true)",
      [roomId, playerId, socketId],
    )

    return acquireLocked(storage, roomId, client)
  })

  if (!lease) {
    throw new Error("Fixture lease was not acquired")
  }

  const game = new CloudGame(storage, roomId)
  game.attachLease(lease)

  return {
    storage,
    game,
    lease,
    roomId,
    roundId,
    playerId,
    socketId,
    hostId,
    question,
    submission: { playerId, socketId, roundId, position: 1, keys: [0] },
  }
}
