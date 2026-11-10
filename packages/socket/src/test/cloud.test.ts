import { EVENTS } from "@razzia/common/constants"
import type { SessionResponse } from "@razzia/common/types/auth"
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@razzia/common/types/game/socket"
import { STATUS } from "@razzia/common/types/game/status"
import { applyScoreFixture } from "@razzia/socket/test/score-fixture"
import { setTimeout as delay } from "node:timers/promises"
import { Pool } from "pg"
import { createClient } from "redis"
import { io, type Socket } from "socket.io-client"
import { expect, it } from "vitest"

const {
  CLOUD_TEST_A,
  CLOUD_TEST_B,
  CLOUD_TEST_DATABASE_URL,
  CLOUD_TEST_REDIS_URL,
} = process.env

const json = async (
  url: string,
  path: string,
  options: { token?: string; data?: unknown; method?: string } = {},
) => {
  const response = await fetch(url + path, {
    method: options.method ?? (options.data === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token && { Authorization: `Bearer ${options.token}` }),
      ...(options.data !== undefined && { "Content-Type": "application/json" }),
    },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  })
  const body: unknown = await response.json()
  expect(response.ok, `${path}: ${JSON.stringify(body)}`).toBe(true)

  return body
}

type Client = Socket<ServerToClientEvents, ClientToServerEvents>
const nextEvent = (socket: Client, event: keyof ServerToClientEvents) =>
  new Promise((resolve) => {
    socket.once(event, (...payload: unknown[]) => resolve(payload.at(0)))
  })

it("persists answers across replicas, waits for B, restores a session and saves tied final results", async ({
  skip,
}) => {
  if (
    !CLOUD_TEST_A ||
    !CLOUD_TEST_B ||
    !CLOUD_TEST_DATABASE_URL ||
    !CLOUD_TEST_REDIS_URL
  ) {
    skip()

    return
  }

  const pool = new Pool({ connectionString: CLOUD_TEST_DATABASE_URL })
  const redis = createClient({ url: CLOUD_TEST_REDIS_URL })
  const sockets: Client[] = []
  const connect = async (url: string, token: string) => {
    const socket: Client = io(url, {
      path: "/ws",
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    })
    sockets.push(socket)
    await nextEvent(socket, "connect")

    return socket
  }

  try {
    await redis.connect()
    const { token: hostToken } = (await json(
      CLOUD_TEST_A,
      "/api/auth/manager",
      {
        data: {
          password: process.env.CLOUD_TEST_MANAGER_PASSWORD ?? "test-password",
        },
      },
    )) as SessionResponse
    const quiz = (await json(CLOUD_TEST_B, "/api/quizz", {
      token: hostToken,
      data: {
        subject: "Week 4 integration",
        gameMode: "quiz",
        questions: [
          {
            type: "single",
            question: "One point?",
            answers: ["Yes", "No"],
            solutions: [0],
            cooldown: 3,
            time: 30,
          },
        ],
      },
    })) as { id: string }
    const { gameId, inviteCode } = (await json(CLOUD_TEST_A, "/api/games", {
      token: hostToken,
      data: { quizzId: quiz.id },
    })) as { gameId: string; inviteCode: string }
    const host = await connect(CLOUD_TEST_A, hostToken)
    const hostReady = nextEvent(host, EVENTS.MANAGER.SUCCESS_RECONNECT)
    host.emit(EVENTS.MANAGER.RECONNECT, { gameId })
    await hostReady
    await json(CLOUD_TEST_B, `/api/games/${gameId}/settings`, {
      method: "PATCH",
      token: hostToken,
      data: { answersOnly: true },
    })

    const join = async (username: string) => {
      const session = (await json(CLOUD_TEST_B, "/api/auth/session", {
        data: {},
      })) as SessionResponse
      const { ticket } = (await json(CLOUD_TEST_B, "/api/games/join", {
        token: session.token,
        data: { inviteCode, username },
      })) as { ticket: string }
      const socket = await connect(CLOUD_TEST_B, session.token)
      const joined = nextEvent(socket, EVENTS.GAME.SUCCESS_JOIN)
      socket.emit(EVENTS.PLAYER.LOGIN, { ticket })
      await joined

      return { socket, session }
    }
    const first = await join("First")
    const second = await join("Second")
    const choose = new Promise<{ roundId: string }>((resolve) => {
      first.socket.on(EVENTS.GAME.STATUS, ({ name, data }) => {
        if (name === STATUS.SELECT_ANSWER) {
          resolve(data as { roundId: string })
        }
      })
    })
    host.emit(EVENTS.MANAGER.START_GAME, { gameId })
    const { roundId } = await choose
    expect(roundId).toBeTypeOf("string")

    const accepted = nextEvent(first.socket, EVENTS.PLAYER.ANSWER_ACK)
    first.socket.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
      gameId,
      roundId,
      data: { answerKeys: [0] },
    })
    await expect(accepted).resolves.toMatchObject({
      status: "accepted",
      answerKeys: [0],
    })
    const duplicate = nextEvent(first.socket, EVENTS.PLAYER.ANSWER_ACK)
    first.socket.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
      gameId,
      roundId,
      data: { answerKeys: [1] },
    })
    await expect(duplicate).resolves.toMatchObject({
      status: "duplicate",
      answerKeys: [0],
    })

    first.socket.disconnect()
    const resumed = await connect(CLOUD_TEST_A, first.session.token)
    const restored = nextEvent(resumed, EVENTS.PLAYER.SUCCESS_RECONNECT)
    resumed.emit(EVENTS.PLAYER.RECONNECT, { gameId })
    await expect(restored).resolves.toMatchObject({
      status: { name: STATUS.WAIT },
      acceptedAnswer: { answerKeys: [0] },
      player: { points: 0 },
    })

    let resultReceived = false
    const result = new Promise((resolve) => {
      resumed.on(EVENTS.GAME.STATUS, ({ name, data }) => {
        if (name === STATUS.SHOW_RESULT) {
          resultReceived = true
          resolve(data)
        }
      })
    })
    const secondResult = new Promise((resolve) => {
      second.socket.on(EVENTS.GAME.STATUS, ({ name, data }) => {
        if (name === STATUS.SHOW_RESULT) {
          resolve(data)
        }
      })
    })
    const secondAccepted = nextEvent(second.socket, EVENTS.PLAYER.ANSWER_ACK)
    second.socket.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
      gameId,
      roundId,
      data: { answerKeys: [0] },
    })
    await expect(secondAccepted).resolves.toMatchObject({ status: "accepted" })
    await expect
      .poll(async () => {
        const { rows } = await pool.query<{ status: string }>(
          "SELECT status FROM rounds WHERE id = $1",
          [roundId],
        )

        return rows.at(0)?.status
      })
      .toBe("closed")
    host.emit(EVENTS.MANAGER.ADVANCE, { gameId })
    await delay(200)
    expect(resultReceived).toBe(false)

    const update = nextEvent(second.socket, EVENTS.PLAYER.UPDATE_LEADERBOARD)
    await applyScoreFixture(pool, gameId)
    await applyScoreFixture(pool, gameId)
    await redis.publish(
      "razzia:leaderboard",
      JSON.stringify({ room_id: gameId }),
    )
    await expect(update).resolves.toMatchObject({
      leaderboard: [
        { points: 1, rank: 1 },
        { points: 1, rank: 1 },
      ],
    })
    await expect(result).resolves.toMatchObject({
      correct: true,
      myPoints: 1,
      points: 1,
      rank: 1,
    })
    await expect(secondResult).resolves.toMatchObject({
      correct: true,
      myPoints: 1,
      points: 1,
      rank: 1,
    })

    const finished = nextEvent(resumed, EVENTS.GAME.STATUS)
    await delay(50)
    host.emit(EVENTS.MANAGER.ADVANCE, { gameId })
    await expect(finished).resolves.toMatchObject({
      name: STATUS.FINISHED,
      data: { rank: 1 },
    })
    await expect(redis.hGet(`razzia:room:${gameId}`, "phase")).resolves.toBe(
      "finished",
    )
    const { results } = (await json(CLOUD_TEST_B, "/api/results", {
      token: hostToken,
    })) as { results: Array<{ id: string; subject: string }> }
    const saved = results.find(
      (entry) => entry.subject === "Week 4 integration",
    )
    expect(saved).toBeDefined()
    const report = await json(CLOUD_TEST_B, `/api/results/${saved?.id}`, {
      token: hostToken,
    })
    expect(report).toMatchObject({
      players: [
        { points: 1, rank: 1 },
        { points: 1, rank: 1 },
      ],
    })
    const {
      rows: [counts],
    } = await pool.query<{ answers: number; events: number }>(
      `SELECT (SELECT count(*)::integer FROM answers WHERE room_id = $1) AS answers,

        (SELECT count(*)::integer FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = $1) AS events`,
      [gameId],
    )
    expect(counts).toEqual({ answers: 2, events: 2 })
    await redis.del(`razzia:room:${gameId}`)
    second.socket.disconnect()
    const databaseOnly = await connect(CLOUD_TEST_B, second.session.token)
    const recovered = nextEvent(databaseOnly, EVENTS.PLAYER.SUCCESS_RECONNECT)
    databaseOnly.emit(EVENTS.PLAYER.RECONNECT, { gameId })
    await expect(recovered).resolves.toMatchObject({
      player: { points: 1 },
      status: { name: STATUS.FINISHED, data: { rank: 1 } },
      acceptedAnswer: { answerKeys: [0] },
    })
  } finally {
    for (const socket of sockets) {
      socket.disconnect()
    }

    if (redis.isOpen) {
      redis.destroy()
    }

    await pool.end()
  }
}, 30000)
