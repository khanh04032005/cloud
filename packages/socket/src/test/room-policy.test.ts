import { beforeAll, afterAll, afterEach, expect, it } from "vitest"
import { Pool } from "pg"
import { z } from "zod"
import { io, type Socket } from "socket.io-client"
import { EVENTS } from "@razzia/common/constants"
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@razzia/common/types/game/socket"
import type { QuizzMode } from "@razzia/common/types/game"

const {
  CLOUD_TEST_A: base,
  CLOUD_TEST_B: other,
  CLOUD_TEST_DATABASE_URL: database,
} = process.env
const enabled = Boolean(base && other && database)
let pool: Pool | undefined = undefined
const rooms: string[] = []
type Client = Socket<ServerToClientEvents, ClientToServerEvents>
const sockets: Client[] = []
beforeAll(() => {
  if (database) {
    pool = new Pool({ connectionString: database })
  }
})
afterEach(async () => {
  await pool?.query(
    "UPDATE rooms SET status = 'cancelled' WHERE id = ANY($1::uuid[]) AND status IN ('lobby','running')",
    [rooms],
  )
  for (const socket of sockets.splice(0)) {
    socket.disconnect()
  }
})
afterAll(async () => {
  await pool?.end()
})

const request = async (
  path: string,
  options: {
    token?: string
    data?: unknown
    method?: string
    url?: string
  } = {},
) => {
  const url = options.url ?? base

  if (!url) {
    throw new Error("Test gateway is unavailable")
  }

  const response = await fetch(url + path, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  })
  const text = await response.text()

  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as unknown,
  }
}
const next = (socket: Client, event: keyof ServerToClientEvents) =>
  new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`Timeout waiting for ${event}`))
    }, 4000)
    const handler = (...values: unknown[]) => {
      clearTimeout(timer)
      resolve(values[0])
    }
    socket.once(event, handler)
  })
const connect = async (token: string, url = other) => {
  const socket: Client = io(url ?? "", {
    path: "/ws",
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    autoConnect: false,
  })
  sockets.push(socket)
  const ready = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("connect_error", reject)
  })
  socket.connect()
  await ready

  return socket
}
const session = async () => {
  const reply = await request("/api/auth/session", {
    data: {},
  })
  expect(reply.status).toBe(200)

  return z.object({ token: z.string() }).parse(reply.body).token
}
const fixture = async (gameMode: QuizzMode = "quiz") => {
  if (!pool) {
    throw new Error("Test database is unavailable")
  }

  const manager = await request("/api/auth/manager", {
    data: { password: "test-password" },
  })
  expect(manager.status).toBe(200)
  const managerBody = z.object({ token: z.string() }).parse(manager.body)
  const quiz = {
    gameMode,
    subject: `Room policy ${Date.now()}`,
    questions: [
      {
        type: "single",
        question: "Original question",
        answers: ["Yes", "No"],
        solutions: [0],
        cooldown: 3,
        time: 30,
      },
    ],
  }
  const saved = await request("/api/quizz", {
    token: managerBody.token,
    data: quiz,
  })
  expect(saved.status).toBe(201)
  const quizId = z.object({ id: z.string() }).parse(saved.body).id
  const created = await request("/api/games", {
    token: managerBody.token,
    data: { quizzId: quizId },
  })
  expect(created.status).toBe(201)
  const createdBody = z
    .object({ gameId: z.string(), inviteCode: z.string() })
    .parse(created.body)
  rooms.push(createdBody.gameId)
  const host = await connect(managerBody.token, base)
  const ready = next(host, EVENTS.MANAGER.SUCCESS_RECONNECT)
  host.emit(EVENTS.MANAGER.RECONNECT, { gameId: createdBody.gameId })
  await ready
  const token = await session()
  const seat = await request("/api/games/join", {
    token,
    data: { inviteCode: createdBody.inviteCode, username: "Existing" },
  })
  expect(seat.status).toBe(200)
  const player = await connect(token)
  const joined = next(player, EVENTS.GAME.SUCCESS_JOIN)
  player.emit(EVENTS.PLAYER.LOGIN, {
    ticket: z.object({ ticket: z.string() }).parse(seat.body).ticket,
  })
  await joined
  const lock = async (locked: boolean) => {
    const updated = next(host, EVENTS.MANAGER.LOCK_UPDATED)
    host.emit(EVENTS.MANAGER.SET_LOCK, { gameId: createdBody.gameId, locked })
    await expect(updated).resolves.toBe(locked)
  }

  return {
    ...createdBody,
    quizId,
    managerToken: managerBody.token,
    quiz,
    host,
    player,
    token,
    lock,
    pool,
  }
}

it.skipIf(!enabled)(
  "locked room rejects new HTTP admissions and tickets issued before locking, but existing players reconnect",
  async () => {
    const record = await fixture()
    const newcomer = await session()
    const pending = await request("/api/games/join", {
      token: newcomer,
      data: { inviteCode: record.inviteCode, username: "Newcomer" },
    })
    expect(pending.status).toBe(200)
    await record.lock(true)
    for (const url of [base, other]) {
      // oxlint-disable-next-line no-await-in-loop -- Check both gateways after the same lock commit.
      const denied = await request("/api/games/join", {
        url,
        token: newcomer,
        data: { inviteCode: record.inviteCode, username: "Newcomer" },
      })
      expect(denied.status).toBe(403)
    }
    const late = await connect(newcomer)
    const denied = next(late, EVENTS.GAME.RESET)
    late.emit(EVENTS.PLAYER.LOGIN, {
      ticket: z.object({ ticket: z.string() }).parse(pending.body).ticket,
    })
    await expect(denied).resolves.toBe("errors:game.locked")
    expect(
      (
        await record.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM players WHERE room_id = $1",
          [record.gameId],
        )
      ).rows[0].n,
    ).toBe(1)
    record.player.disconnect()
    const returned = await connect(record.token, base)
    const restored = next(returned, EVENTS.PLAYER.SUCCESS_RECONNECT)
    returned.emit(EVENTS.PLAYER.RECONNECT, { gameId: record.gameId })
    await expect(restored).resolves.toMatchObject({
      player: { username: "Existing" },
      gameMode: "quiz",
    })
    expect(
      (
        await request("/api/games/join", {
          token: record.token,
          data: { inviteCode: record.inviteCode, username: "Existing" },
        })
      ).body,
    ).toMatchObject({ ticket: null })
    await record.lock(false)
    const admitted = await request("/api/games/join", {
      token: newcomer,
      data: { inviteCode: record.inviteCode, username: "Newcomer" },
    })
    expect(admitted.status).toBe(200)
    const joined = next(late, EVENTS.GAME.SUCCESS_JOIN)
    late.emit(EVENTS.PLAYER.LOGIN, {
      ticket: z.object({ ticket: z.string() }).parse(admitted.body).ticket,
    })
    await joined
    expect(
      (
        await record.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM players WHERE room_id = $1",
          [record.gameId],
        )
      ).rows[0].n,
    ).toBe(2)
  },
)

it.skipIf(!enabled)(
  "locking one room leaves admissions to another room available",
  async () => {
    const first = await fixture()
    const second = await fixture()
    await first.lock(true)
    const token = await session()
    expect(
      (
        await request("/api/games/join", {
          token,
          data: { inviteCode: first.inviteCode, username: "Visitor" },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request("/api/games/join", {
          token,
          data: { inviteCode: second.inviteCode, username: "Visitor" },
        })
      ).status,
    ).toBe(200)
  },
)

it.skipIf(!enabled).each(["quiz", "survey"] as const)(
  "room mode %s survives catalog mode changes, invalid removal and quiz deletion",
  async (mode) => {
    const record = await fixture(mode)
    const opposite: QuizzMode = mode === "quiz" ? "survey" : "quiz"
    const snapshot = async () =>
      (
        await record.pool.query<{
          game_mode: string
          quiz_id: string | null
          subject: string
        }>("SELECT game_mode, quiz_id, subject FROM rooms WHERE id = $1", [
          record.gameId,
        ])
      ).rows[0]
    const original = await snapshot()
    expect(
      (
        await request(`/api/quizz/${record.quizId}`, {
          method: "PATCH",
          token: record.managerToken,
          data: { ...record.quiz, gameMode: opposite },
        })
      ).status,
    ).toBe(200)
    expect(await snapshot()).toEqual(original)
    expect(
      (
        await record.pool.query<{ game_mode: string }>(
          "SELECT game_mode FROM quizzes WHERE id = $1",
          [record.quizId],
        )
      ).rows[0].game_mode,
    ).toBe(opposite)
    const { gameMode: _removed, ...withoutMode } = record.quiz
    expect(
      (
        await request(`/api/quizz/${record.quizId}`, {
          method: "PATCH",
          token: record.managerToken,
          data: withoutMode,
        })
      ).status,
    ).toBe(400)
    await expect(
      record.pool.query("UPDATE quizzes SET game_mode = NULL WHERE id = $1", [
        record.quizId,
      ]),
    ).rejects.toMatchObject({ code: "23502" })
    expect(await snapshot()).toEqual(original)
    expect(
      (
        await request(`/api/quizz/${record.quizId}`, {
          method: "DELETE",
          token: record.managerToken,
        })
      ).status,
    ).toBe(204)
    expect(await snapshot()).toEqual({ ...original, quiz_id: null })
    record.player.disconnect()
    const player = await connect(record.token, base)
    const restored = next(player, EVENTS.PLAYER.SUCCESS_RECONNECT)
    player.emit(EVENTS.PLAYER.RECONNECT, { gameId: record.gameId })
    await expect(restored).resolves.toMatchObject({
      gameMode: mode,
      player: { username: "Existing" },
    })
  },
)

it.skipIf(!enabled)(
  "manager reconnect on another gateway restores persisted settings, lock and host connection",
  async () => {
    const record = await fixture()
    const settings = {
      generatedUsernames: false,
      answersOnly: true,
      autoAdvance: { enable: true, responsesDelay: 7, leaderboardDelay: 9 },
    }
    const updated = await request(`/api/games/${record.gameId}/settings`, {
      token: record.managerToken,
      method: "PATCH",
      data: settings,
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ settings })
    await record.lock(true)
    const host = await connect(record.managerToken, other)
    const ready = next(host, EVENTS.MANAGER.SUCCESS_RECONNECT)
    host.emit(EVENTS.MANAGER.RECONNECT, { gameId: record.gameId })
    await expect(ready).resolves.toMatchObject({
      settings,
      locked: true,
      currentQuestion: null,
    })
    const stored = await record.pool.query<{
      settings: typeof settings
      locked: boolean
      manager_socket_id: string
      manager_connected: boolean
    }>(
      "SELECT settings, locked, manager_socket_id, manager_connected FROM rooms WHERE id = $1",
      [record.gameId],
    )
    expect(stored.rows).toEqual([
      {
        settings,
        locked: true,
        manager_socket_id: host.id,
        manager_connected: true,
      },
    ])
  },
)
