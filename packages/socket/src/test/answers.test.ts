import { STATUS } from "@razzia/common/types/game/status"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { Cloud } from "@razzia/socket/services/cloud"
import {
  acquireLease,
  acquireLocked,
  renewLease,
  releaseLease,
  withLease,
} from "@razzia/socket/services/leases"
import { CloudGame } from "@razzia/socket/services/cloud-game"
import { applyScoreFixture } from "@razzia/socket/test/score-fixture"
import type { GameSocket } from "@razzia/socket/handlers/types"

const database = process.env.CLOUD_TEST_DATABASE_URL
const redis = process.env.CLOUD_TEST_REDIS_URL
const enabled = Boolean(database && redis)
let storage: Cloud | undefined = undefined
const rooms: string[] = []

beforeAll(async () => {
  if (!database || !redis) {
    return
  }

  storage = new Cloud(database, redis)
  await storage.connect()
})

afterEach(async () => {
  await storage?.pool.query(
    "UPDATE rooms SET status = 'cancelled' WHERE id = ANY($1::uuid[]) AND status IN ('lobby', 'running')",
    [rooms],
  )
})

afterAll(async () => {
  if (!storage) {
    return
  }

  await storage.transaction(async (client) => {
    await client.query(
      "DELETE FROM processed_answer_events WHERE event_id IN (SELECT o.event_id FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = ANY($1::uuid[]))",
      [rooms],
    )
    await client.query(
      "DELETE FROM outbox WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ANY($1::uuid[]))",
      [rooms],
    )
    await client.query("DELETE FROM answers WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM results WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query(
      "DELETE FROM game_reports WHERE room_id = ANY($1::uuid[])",
      [rooms],
    )
    await client.query("DELETE FROM rounds WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM players WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [rooms])
  })
  await storage.close()
})

const fixture = async () => {
  if (!storage) {
    throw new Error("Cloud test storage is unavailable")
  }

  const roomId = randomUUID()
  const roundId = randomUUID()
  const playerId = randomUUID()
  const socketId = randomUUID()
  const question = {
    type: "single",
    question: "Test?",
    answers: ["Correct", "Wrong"],
    solutions: [0],
    time: 30,
    cooldown: 3,
  }
  const fixtureStorage = storage
  const lease = await storage.transaction(async (client) => {
    await client.query(
      "INSERT INTO rooms (id, invite_code, host_client_id, subject, status, current_position) VALUES ($1, $2, $3, 'Answer test', 'running', 1)",
      [
        roomId,
        String(Math.floor(Math.random() * 1000000)).padStart(6, "0"),
        randomUUID(),
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

    return acquireLocked(fixtureStorage, roomId, client)
  })
  rooms.push(roomId)
  const game = new CloudGame(storage, roomId)

  if (!lease) {
    throw new Error("Fixture lease was not acquired")
  }

  game.attachLease(lease)
  const submission = { playerId, socketId, roundId, position: 1, keys: [0] }

  return {
    storage,
    game,
    lease,
    roomId,
    roundId,
    playerId,
    socketId,
    submission,
  }
}

it.skipIf(!enabled)(
  "commits one immutable answer and event under concurrent retries, including after close",
  async () => {
    const { storage: db, game, roomId, roundId, submission } = await fixture()
    const receipts = await Promise.all([
      game.accept(submission),
      game.accept({ ...submission, keys: [1] }),
    ])
    expect(receipts.map(({ status }) => status).sort()).toEqual([
      "accepted",
      "duplicate",
    ])
    expect(receipts[0].answerKeys).toEqual(receipts[1].answerKeys)
    expect(receipts[0]).not.toHaveProperty("is_correct")
    await db.pool.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
      roundId,
    ])
    await expect(
      game.accept({ ...submission, keys: [1] }),
    ).resolves.toMatchObject({
      status: "duplicate",
      answerKeys: receipts[0].answerKeys,
      acceptedAt: receipts[0].acceptedAt,
    })
    const {
      rows: [count],
    } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = $1",
      [roomId],
    )
    expect(count.count).toBe(1)
  },
)

it.skipIf(!enabled)(
  "rolls the answer back when the outbox insert fails",
  async () => {
    const { storage: db, game, roomId, roundId, submission } = await fixture()
    const name = `reject_outbox_${randomUUID().replaceAll("-", "")}`
    await db.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected outbox failure'; END $$`,
    )

    try {
      await db.pool.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.round_id = '${roundId}'::uuid) EXECUTE FUNCTION ${name}()`,
      )
      await expect(game.accept(submission)).rejects.toThrow(
        "Injected outbox failure",
      )
      const {
        rows: [count],
      } = await db.pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM answers WHERE room_id = $1",
        [roomId],
      )
      expect(count.count).toBe(0)
    } finally {
      await db.pool.query(`DROP TRIGGER IF EXISTS ${name} ON outbox`)
      await db.pool.query(`DROP FUNCTION ${name}()`)
    }

    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "accepted",
    })
  },
)

it.skipIf(!enabled)(
  "rejects expired, foreign and invalid submissions without creating events",
  async () => {
    const { storage: db, game, roundId, submission } = await fixture()
    await expect(
      game.accept({ ...submission, keys: [4] }),
    ).resolves.toMatchObject({ status: "invalid" })
    await expect(
      game.accept({ ...submission, playerId: randomUUID() }),
    ).resolves.toMatchObject({ status: "forbidden" })
    await expect(
      game.accept({ ...submission, socketId: "old-connection" }),
    ).resolves.toMatchObject({ status: "forbidden" })
    await db.pool.query(
      "UPDATE rounds SET closes_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [roundId],
    )
    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "closed",
    })
    const {
      rows: [count],
    } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM answers WHERE round_id = $1",
      [roundId],
    )
    expect(count.count).toBe(0)
  },
)

it.skipIf(!enabled)(
  "checks the server deadline after waiting for a concurrent close transaction",
  async () => {
    const { storage: db, game, roundId, submission } = await fixture()
    const closer = await db.pool.connect()

    try {
      await closer.query("BEGIN")
      await closer.query("SELECT id FROM rounds WHERE id = $1 FOR UPDATE", [
        roundId,
      ])
      const receipt = game.accept(submission)
      await closer.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
        roundId,
      ])
      await closer.query("COMMIT")
      await expect(receipt).resolves.toMatchObject({ status: "closed" })
    } finally {
      await closer.query("ROLLBACK")
      closer.release()
    }
  },
)

it.skipIf(!enabled)(
  "restores accepted choice and worker score from DB with an empty Redis room cache",
  async () => {
    const {
      storage: db,
      game,
      roomId,
      playerId,
      socketId,
      submission,
    } = await fixture()
    await game.broadcast(
      {
        name: "SELECT_ANSWER",
        data: {
          question: "Test?",
          answers: ["Correct", "Wrong"],
          time: 30,
          totalPlayer: 1,
          questionType: "single",
          answersOnly: false,
        },
      },
      1,
    )
    await game.accept(submission)
    await applyScoreFixture(db.pool, roomId)
    await applyScoreFixture(db.pool, roomId)
    await db.redis.del(`razzia:room:${roomId}`)
    const socket = {
      id: "new-connection",
      data: { clientId: playerId, role: "player" },
    } as GameSocket
    const restored = await game.reconnect(socket)
    expect(restored?.player.id).toBe(socketId)
    expect(restored?.payload).toMatchObject({
      player: { points: 1 },
      status: { name: "WAIT" },
      acceptedAnswer: { answerKeys: [0] },
    })
    const scores = await game.scores(1)
    expect(scores).toMatchObject([{ points: 1, rank: 1 }])
  },
)

it.skipIf(!enabled)(
  "fences stale owners and preserves the successor lease on late renewal and release",
  async () => {
    const { storage: db, game, lease, roomId, submission } = await fixture()
    expect(await acquireLease(db, roomId)).toBeUndefined()
    await db.pool.query(
      "UPDATE rooms SET lease_until = '-infinity' WHERE id = $1",
      [roomId],
    )
    await db.redis.del(`razzia:lease:${roomId}`)
    const successor = await acquireLease(db, roomId)
    expect(successor?.epoch).toBe(lease.epoch + 1)

    if (!successor) {
      throw new Error("Successor missing")
    }

    await expect(game.accept(submission)).rejects.toThrow("Room lease lost")
    await expect(renewLease(db, lease)).rejects.toThrow("Room lease lost")
    await expect(
      db.phase(roomId, { phase: "closed", position: 1 }, lease),
    ).rejects.toThrow("Room lease lost")
    await releaseLease(db, lease)
    expect(await db.redis.get(`razzia:lease:${roomId}`)).toBe(successor.token)
    await expect(
      withLease(db, successor, async (client) => {
        const { rows } = await client.query(
          "SELECT id FROM rooms WHERE id = $1",
          [roomId],
        )

        return rows.length
      }),
    ).resolves.toBe(1)
    await releaseLease(db, successor)
  },
)

it.skipIf(!enabled)(
  "keeps one answer and outbox event through a burst of 64 retries",
  async () => {
    const { storage: db, game, roomId, submission } = await fixture()
    const receipts = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        game.accept({ ...submission, keys: [index % 2] }),
      ),
    )
    expect(
      receipts.filter((receipt) => receipt.status === "accepted"),
    ).toHaveLength(1)
    expect(
      receipts.filter((receipt) => receipt.status === "duplicate"),
    ).toHaveLength(63)
    const canonical = receipts.find((receipt) => receipt.status === "accepted")
    expect(
      receipts.every(
        (receipt) =>
          JSON.stringify(receipt.answerKeys) ===
          JSON.stringify(canonical?.answerKeys),
      ),
    ).toBe(true)
    const {
      rows: [counts],
    } = await db.pool.query<{ answers: number; events: number }>(
      "SELECT (SELECT count(*)::integer FROM answers WHERE room_id = $1) AS answers, (SELECT count(*)::integer FROM outbox WHERE round_id IN (SELECT id FROM rounds WHERE room_id = $1)) AS events",
      [roomId],
    )
    expect(counts).toEqual({ answers: 1, events: 1 })
  },
)

it.skipIf(!enabled)(
  "commits final reconnect snapshots with the report before final socket notifications",
  async () => {
    const { storage: db, game, roomId, playerId, submission } = await fixture()
    await game.accept(submission)
    await applyScoreFixture(db.pool, roomId)
    await game.saveReport({
      id: randomUUID(),
      gameMode: "quiz",
      subject: "Atomic final",
      date: new Date().toISOString(),
      players: [{ username: "Test player", points: 1, rank: 1 }],
      questions: [],
    })
    const recovered = await new CloudGame(db, roomId).reconnect({
      id: "after-crash",
      data: { clientId: playerId, role: "player" },
    } as GameSocket)
    expect(recovered?.payload.status).toMatchObject({
      name: STATUS.FINISHED,
      data: { rank: 1, subject: "Atomic final" },
    })
  },
)

it.skipIf(!enabled)(
  "drops readiness when its Redis dependency is disconnected",
  async () => {
    if (!database || !redis) {
      throw new Error("Test dependencies unavailable")
    }

    const probe = new Cloud(database, redis)

    try {
      await probe.connect()
      expect(await probe.ready()).toBe(true)
      probe.redis.destroy()
      expect(await probe.ready()).toBe(false)
    } finally {
      await probe.close()
    }
  },
)
