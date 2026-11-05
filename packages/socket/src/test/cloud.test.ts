import { EVENTS } from "@razzia/common/constants"
import type { SessionResponse } from "@razzia/common/types/auth"
import type { QuizzMeta } from "@razzia/common/types/game"
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@razzia/common/types/game/socket"
import { STATUS } from "@razzia/common/types/game/status"
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

it("shares room admission and rounds between two socket replicas", async ({
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
    const {
      quizz: [quiz],
    } = (await json(CLOUD_TEST_B, "/api/quizz", { token: hostToken })) as {
      quizz: QuizzMeta[]
    }
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
    const { token: playerToken, clientId } = (await json(
      CLOUD_TEST_B,
      "/api/auth/session",
      { data: {} },
    )) as SessionResponse
    const { ticket } = (await json(CLOUD_TEST_B, "/api/games/join", {
      token: playerToken,
      data: { inviteCode, username: "Cloud Player" },
    })) as { ticket: string }
    const player = await connect(CLOUD_TEST_B, playerToken)
    const joined = nextEvent(player, EVENTS.GAME.SUCCESS_JOIN)
    const hostSawJoin = nextEvent(host, EVENTS.MANAGER.NEW_PLAYER)
    player.emit(EVENTS.PLAYER.LOGIN, { ticket })
    await expect(joined).resolves.toMatchObject({
      gameId,
      username: "Cloud Player",
    })
    await expect(hostSawJoin).resolves.toMatchObject({ clientId })

    const choose = new Promise((resolve) => {
      player.on(EVENTS.GAME.STATUS, ({ name, data }) => {
        if (name === STATUS.SELECT_ANSWER) {
          resolve(data)
        }
      })
    })
    host.emit(EVENTS.MANAGER.START_GAME, { gameId })
    await expect(choose).resolves.toMatchObject({ answersOnly: true })

    const {
      rows: [round],
    } = await pool.query<{
      room_status: string
      username: string
      round_status: string
      closes_at: Date
    }>(
      `SELECT r.status AS room_status, p.username, s.status AS round_status, s.closes_at
       FROM rooms r JOIN players p ON p.room_id = r.id
       JOIN rounds s ON s.room_id = r.id AND s.position = 1
       WHERE r.id = $1 AND p.id = $2`,
      [gameId, clientId],
    )
    expect(round).toMatchObject({
      room_status: "running",
      username: "Cloud Player",
      round_status: "open",
    })
    expect(round.closes_at).toBeInstanceOf(Date)
    await expect(redis.hGetAll(`razzia:room:${gameId}`)).resolves.toMatchObject(
      { phase: "open", position: "1" },
    )

    const answered = nextEvent(host, EVENTS.GAME.PLAYER_ANSWER)
    const roundEnded = new Promise((resolve) => {
      player.on(EVENTS.GAME.STATUS, ({ name, data }) => {
        if (name === STATUS.SHOW_RESULT) {
          resolve(data)
        }
      })
    })
    player.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
      gameId,
      data: { answerKeys: [0] },
    })
    await expect(answered).resolves.toBe(1)
    await expect(roundEnded).resolves.toHaveProperty("myPoints")
    const {
      rows: [closed],
    } = await pool.query<{ status: string }>(
      "SELECT status FROM rounds WHERE room_id = $1 AND position = 1",
      [gameId],
    )

    expect(closed.status).toBe("closed")
  } finally {
    for (const socket of sockets) {
      socket.disconnect()
    }

    if (redis.isOpen) {
      redis.destroy()
    }

    await pool.end()
  }
}, 25000)
