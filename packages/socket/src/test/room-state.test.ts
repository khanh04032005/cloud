import { randomUUID } from "node:crypto"
import { beforeAll, afterAll, afterEach, expect, it } from "vitest"
import { STATUS } from "@razzia/common/types/game/status"
import type { GameSocket } from "@razzia/socket/handlers/types"
import { Cloud } from "@razzia/socket/services/cloud"
import { CloudGame, type GameState } from "@razzia/socket/services/cloud-game"
import { renewLease, releaseLease } from "@razzia/socket/services/leases"
import { ownedRoom } from "@razzia/socket/test/owned-room"
import { applyScoreFixture } from "@razzia/socket/test/score-fixture"
import { SECOND_MS } from "@razzia/socket/utils/sleep"

const database = process.env.CLOUD_TEST_DATABASE_URL
const cache = process.env.CLOUD_TEST_REDIS_URL
const enabled = Boolean(database && cache)
let storage: Cloud | undefined = undefined
const roomIds: string[] = []
beforeAll(async () => {
  if (database && cache) {
    storage = new Cloud(database, cache)
    await storage.connect()
  }
})
afterEach(async () => {
  await storage?.pool.query(
    "UPDATE rooms SET status = 'cancelled' WHERE id = ANY($1::uuid[]) AND status IN ('lobby','running')",
    [roomIds],
  )
})
afterAll(async () => {
  if (!storage) {
    return
  }

  await storage.transaction(async (client) => {
    await client.query(
      "DELETE FROM processed_answer_events WHERE event_id IN (SELECT o.event_id FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = ANY($1::uuid[]))",
      [roomIds],
    )
    await client.query(
      "DELETE FROM outbox WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ANY($1::uuid[]))",
      [roomIds],
    )
    for (const table of [
      "answers",
      "results",
      "game_reports",
      "rounds",
      "players",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Delete dependent fixture rows in FK order.
      await client.query(
        `DELETE FROM ${table} WHERE room_id = ANY($1::uuid[])`,
        [roomIds],
      )
    }
    await client.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [
      roomIds,
    ])
  })
  await storage.close()
})
const fixture = async () => {
  if (!storage) {
    throw new Error("Test database is unavailable")
  }

  const record = await ownedRoom(storage)
  roomIds.push(record.roomId)

  return record
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const socketFor = (record: Fixture, id = randomUUID()) =>
  ({ id, data: { clientId: record.playerId, role: "player" } }) as GameSocket
const selection = (roundId: string): GameState => ({
  name: STATUS.SELECT_ANSWER,
  data: {
    roundId,
    question: "Round two",
    answers: ["Correct", "Wrong"],
    time: 60,
    totalPlayer: 1,
    questionType: "single",
    answersOnly: false,
  },
})
const secondRound = async (record: Fixture) => {
  const id = randomUUID()
  await record.storage.transaction(async (client) => {
    await client.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
      record.roundId,
    ])
    await client.query(
      "INSERT INTO rounds (id, room_id, position, question_snapshot, status, closes_at) SELECT $1, room_id, 2, question_snapshot, 'open', clock_timestamp() + interval '1 minute' FROM rounds WHERE id = $2",
      [id, record.roundId],
    )
  })

  return id
}

it.skipIf(!enabled)(
  "reconnect reads runtime/current_position from DB and ignores a previous-round player result",
  async () => {
    const record = await fixture()
    await record.game.accept(record.submission)
    await applyScoreFixture(record.storage.pool, record.roomId)
    await secondRound(record)
    await record.game.playerState(
      record.playerId,
      { name: STATUS.FINISHED, data: { subject: "Stale", top: [] } },
      1,
    )
    await record.game.broadcast(
      {
        name: STATUS.SHOW_QUESTION,
        data: { question: "Round two", cooldown: 3 },
      },
      2,
    )
    await record.storage.redis.del(`razzia:room:${record.roomId}`)
    const socket = socketFor(record)
    const restored = await new CloudGame(
      record.storage,
      record.roomId,
    ).reconnect(socket)
    expect(restored?.payload).toMatchObject({
      status: { name: STATUS.SHOW_QUESTION, data: { question: "Round two" } },
      currentQuestion: { current: 2, total: 2 },
      player: { points: 1 },
      acceptedAnswer: null,
    })
    expect(
      (
        await record.storage.pool.query<{
          socket_id: string
          connected: boolean
        }>(
          "SELECT socket_id, connected FROM players WHERE room_id = $1 AND id = $2",
          [record.roomId, record.playerId],
        )
      ).rows,
    ).toEqual([{ socket_id: socket.id, connected: true }])
  },
)

it.skipIf(!enabled)(
  "reconnect resumes the remaining answer time without extending its deadline",
  async () => {
    const record = await fixture()
    const roundId = await secondRound(record)
    const deadline = new Date(Date.now() + 4 * SECOND_MS)
    await record.storage.pool.query(
      "UPDATE rounds SET closes_at = $2 WHERE id = $1",
      [roundId, deadline],
    )
    await record.game.broadcast(selection(roundId), 2, deadline)
    const restored = await record.game.reconnect(socketFor(record))
    expect(restored?.payload).toMatchObject({
      status: { name: STATUS.SELECT_ANSWER },
      currentQuestion: { current: 2, total: 2 },
      acceptedAnswer: null,
    })

    if (!restored) {
      throw new Error("Expected a restored player session")
    }

    const remaining = (restored.payload.status.data as { time: number }).time
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(4)
    expect(
      (
        await record.storage.pool.query<{ closes_at: Date }>(
          "SELECT closes_at FROM rounds WHERE id = $1",
          [roundId],
        )
      ).rows[0].closes_at,
    ).toEqual(deadline)
  },
)

it.skipIf(!enabled)(
  "reconnect of an answered round restores WAIT and the original answer, without another outbox",
  async () => {
    const record = await fixture()
    await record.game.broadcast(selection(record.roundId), 1)
    const receipt = await record.game.accept(record.submission)
    const socket = socketFor(record)
    const restored = await new CloudGame(
      record.storage,
      record.roomId,
    ).reconnect(socket)
    expect(restored?.payload).toMatchObject({
      status: { name: STATUS.WAIT },
      currentQuestion: { current: 1, total: 1 },
      acceptedAnswer: { answerKeys: [0], acceptedAt: receipt.acceptedAt },
    })
    await expect(
      record.game.accept({
        ...record.submission,
        socketId: socket.id,
        keys: [1],
      }),
    ).resolves.toEqual({ ...receipt, status: "duplicate" })
    expect(
      (
        await record.storage.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbox WHERE round_id = $1",
          [record.roundId],
        )
      ).rows[0].count,
    ).toBe(1)
  },
)

it.skipIf(!enabled)(
  "reconnect of a closed round shows WAIT, never reopens answering",
  async () => {
    const record = await fixture()
    await record.game.broadcast(selection(record.roundId), 1)
    await record.storage.pool.query(
      "UPDATE rounds SET status = 'closed' WHERE id = $1",
      [record.roundId],
    )
    const socket = socketFor(record)
    expect((await record.game.reconnect(socket))?.payload).toMatchObject({
      status: { name: STATUS.WAIT },
      acceptedAnswer: null,
    })
    await expect(
      record.game.accept({ ...record.submission, socketId: socket.id }),
    ).resolves.toMatchObject({ status: "closed" })
  },
)

it.skipIf(!enabled)(
  "an expired open round reconnects with zero remaining time and accepts no new answer",
  async () => {
    const record = await fixture()
    await record.game.broadcast(selection(record.roundId), 1)
    await record.storage.pool.query(
      "UPDATE rounds SET closes_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [record.roundId],
    )
    const socket = socketFor(record)
    expect((await record.game.reconnect(socket))?.payload.status).toMatchObject(
      { name: STATUS.SELECT_ANSWER, data: { time: 0 } },
    )
    await expect(
      record.game.accept({ ...record.submission, socketId: socket.id }),
    ).resolves.toMatchObject({ status: "closed" })
    expect(
      (
        await record.storage.pool.query(
          "SELECT * FROM answers WHERE room_id = $1",
          [record.roomId],
        )
      ).rows,
    ).toHaveLength(0)
  },
)

it.skipIf(!enabled)(
  "reconnect without runtime falls back to the lobby and no current question",
  async () => {
    const record = await fixture()
    await record.storage.pool.query(
      "UPDATE rooms SET status = 'lobby', runtime = NULL, current_position = 0 WHERE id = $1",
      [record.roomId],
    )
    await record.storage.pool.query(
      "UPDATE rounds SET status = 'pending' WHERE id = $1",
      [record.roundId],
    )
    expect(
      (await record.game.reconnect(socketFor(record)))?.payload,
    ).toMatchObject({
      status: { name: STATUS.WAIT, data: { text: "game:waitingForPlayers" } },
      currentQuestion: null,
      acceptedAnswer: null,
    })
  },
)

it.skipIf(!enabled).each(["cancelled", "inactive"] as const)(
  "reconnect does not change socket identity for an invalid membership: %s",
  async (reason) => {
    const record = await fixture()

    if (reason === "cancelled") {
      await record.storage.pool.query(
        "UPDATE rooms SET status = 'cancelled' WHERE id = $1",
        [record.roomId],
      )
    } else {
      await record.storage.pool.query(
        "UPDATE players SET active = false WHERE room_id = $1",
        [record.roomId],
      )
    }

    await expect(
      record.game.reconnect(socketFor(record)),
    ).resolves.toBeUndefined()
    expect(
      (
        await record.storage.pool.query<{ socket_id: string }>(
          "SELECT socket_id FROM players WHERE room_id = $1",
          [record.roomId],
        )
      ).rows[0].socket_id,
    ).toBe(record.socketId)
  },
)

it.skipIf(!enabled)(
  "room runtime, host snapshot and deadline fields persist together and clear on explicit phase changes",
  async () => {
    const record = await fixture()
    const stageDeadline = new Date(Date.now() + 10000)
    const autoAdvanceAt = new Date(Date.now() + 20000)
    await record.game.broadcast(
      {
        name: STATUS.SHOW_QUESTION,
        data: { question: "Question", cooldown: 3 },
      },
      1,
      stageDeadline,
    )
    await record.game.managerState(
      { name: STATUS.SHOW_ROOM, data: { text: "Host snapshot" } },
      1,
      autoAdvanceAt,
    )
    await record.game.managerConnection("host-socket", true)
    const query = () =>
      record.storage.pool.query<{
        runtime: GameState
        current_position: number
        host_state: GameState | null
        host_state_position: number
        stage_deadline: Date | null
        auto_advance_at: Date | null
        manager_socket_id: string
        manager_connected: boolean
      }>(
        "SELECT runtime, current_position, host_state, host_state_position, stage_deadline, auto_advance_at, manager_socket_id, manager_connected FROM rooms WHERE id = $1",
        [record.roomId],
      )
    expect((await query()).rows[0]).toMatchObject({
      runtime: { name: STATUS.SHOW_QUESTION },
      current_position: 1,
      host_state: { name: STATUS.SHOW_ROOM },
      host_state_position: 1,
      stage_deadline: stageDeadline,
      auto_advance_at: autoAdvanceAt,
      manager_socket_id: "host-socket",
      manager_connected: true,
    })
    const nextRoundId = await secondRound(record)
    await record.game.broadcast(selection(nextRoundId), 2)
    expect((await query()).rows[0]).toMatchObject({
      current_position: 2,
      host_state: null,
      stage_deadline: null,
    })
    await record.game.managerState(
      { name: STATUS.SHOW_ROOM, data: { text: "Next phase" } },
      2,
      null,
    )
    await record.game.managerConnection("host-socket", false)
    expect((await query()).rows[0]).toMatchObject({
      host_state_position: 2,
      auto_advance_at: null,
      manager_connected: false,
    })
  },
)

it.skipIf(!enabled)(
  "renewal extends the lease without changing owner identity; release fences subsequent writes",
  async () => {
    const record = await fixture()
    await record.storage.pool.query(
      "UPDATE rooms SET lease_until = clock_timestamp() + interval '1 second' WHERE id = $1",
      [record.roomId],
    )
    const query = () =>
      record.storage.pool.query<{
        owner_token: string
        owner_epoch: number
        lease_until: Date
        expired: boolean
      }>(
        "SELECT owner_token, owner_epoch, lease_until, lease_until <= clock_timestamp() AS expired FROM rooms WHERE id = $1",
        [record.roomId],
      )
    const {
      rows: [before],
    } = await query()
    await renewLease(record.storage, record.lease)
    const {
      rows: [renewed],
    } = await query()
    expect(renewed.owner_token).toBe(before.owner_token)
    expect(renewed.owner_epoch).toBe(before.owner_epoch)
    expect(renewed.lease_until.getTime()).toBeGreaterThan(
      before.lease_until.getTime(),
    )
    await record.storage.pool.query(
      "UPDATE rooms SET status = 'cancelled' WHERE id = $1",
      [record.roomId],
    )
    await releaseLease(record.storage, record.lease)
    expect((await query()).rows[0].expired).toBe(true)
    expect(record.lease.active).toBe(false)
    expect(
      await record.storage.redis.get(`razzia:lease:${record.roomId}`),
    ).toBeNull()
    await expect(
      record.game.managerConnection("stale-host", true),
    ).rejects.toThrow("Room lease lost")
  },
)

it.skipIf(!enabled)(
  "a current-round player result overrides runtime on reconnect",
  async () => {
    const record = await fixture()
    await record.game.accept(record.submission)
    await applyScoreFixture(record.storage.pool, record.roomId)
    await record.storage.pool.query(
      "UPDATE rounds SET status = 'closed' WHERE id = $1",
      [record.roundId],
    )
    await record.game.broadcast(
      { name: STATUS.WAIT, data: { text: "Global state" } },
      1,
    )
    await record.game.playerState(
      record.playerId,
      {
        name: STATUS.SHOW_RESULT,
        data: {
          correct: true,
          message: "Correct",
          points: 1,
          myPoints: 1,
          rank: 1,
          aheadOfMe: null,
        },
      },
      1,
    )
    expect(
      (
        await new CloudGame(record.storage, record.roomId).reconnect(
          socketFor(record),
        )
      )?.payload,
    ).toMatchObject({
      status: { name: STATUS.SHOW_RESULT, data: { myPoints: 1 } },
      currentQuestion: { current: 1, total: 1 },
      acceptedAnswer: { answerKeys: [0] },
      player: { points: 1 },
    })
  },
)

it.skipIf(!enabled)(
  "finished host reconnect restores durable lock/state/position and checks host identity",
  async () => {
    const record = await fixture()
    await record.storage.pool.query(
      "UPDATE rooms SET locked = true WHERE id = $1",
      [record.roomId],
    )
    await record.game.managerConnection("old-host", true)
    await record.game.saveReport({
      id: randomUUID(),
      gameMode: "quiz",
      subject: "Final room state",
      date: new Date().toISOString(),
      players: [{ username: "Test player", points: 0, rank: 1 }],
      questions: [],
    })
    await record.storage.redis.del(`razzia:room:${record.roomId}`)
    const restored = new CloudGame(record.storage, record.roomId)
    const host = {
      id: "new-host",
      data: { clientId: record.hostId, role: "manager" },
    } as GameSocket
    expect(await restored.finishedHost(host)).toMatchObject({
      locked: true,
      status: { name: STATUS.FINISHED },
      currentQuestion: { current: 1, total: 1 },
      players: [{ username: "Test player", points: 0 }],
    })
    await expect(
      restored.finishedHost({
        ...host,
        data: { clientId: randomUUID(), role: "manager" },
      }),
    ).resolves.toBeUndefined()
    await expect(
      restored.finishedHost({
        ...host,
        data: { clientId: record.hostId, role: "player" },
      }),
    ).resolves.toBeUndefined()
  },
)
