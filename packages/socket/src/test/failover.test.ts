import type { GameResult } from "@razzia/common/types/game"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join as joinPath, resolve as resolvePath } from "node:path"
import { createServer } from "node:net"

const startOwner = async (database: string, redis: string) => {
  const listener = createServer()
  await new Promise<void>((done) => {
    listener.listen(0, "127.0.0.1", done)
  })
  const address = listener.address()

  if (!address || typeof address === "string") {
    throw new Error("Test port unavailable")
  }

  const { port } = address
  await new Promise<void>((done) => {
    listener.close(() => done())
  })
  const directory = await mkdtemp(joinPath(tmpdir(), "razzia-owner-"))
  const process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: resolvePath("packages/socket"),
      windowsHide: true,
      env: {
        ...globalThis.process.env,
        DATABASE_URL: database,
        REDIS_URL: redis,
        SOCKET_PORT: String(port),
        CONFIG_PATH: directory,
        ROOM_LEASE_TTL_MS: "1500",
        JWT_SECRET: "week4-test-shared-secret-at-least-32-characters",
        MANAGER_PASSWORD: "test-password",
        GAME_SPEED: "5",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let logs = ""
  process.stdout.on("data", (chunk: Buffer) => {
    logs += chunk.toString()
  })
  process.stderr.on("data", (chunk: Buffer) => {
    logs += chunk.toString()
  })
  const url = `http://127.0.0.1:${port}`

  try {
    await expect
      .poll(
        () => {
          if (process.exitCode !== null) {
            throw new Error(logs)
          }

          return fetch(`${url}/health/ready`)
            .then((response) => response.ok)
            .catch(() => false)
        },
        { timeout: 15000 },
      )
      .toBe(true)

    return { process, directory, url }
  } catch (error) {
    process.kill()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

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
  CLOUD_TEST_A: GATEWAY_A,
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

it("takes over a killed coordinator without resetting the round or duplicating accepted answers", async ({
  skip,
}) => {
  if (
    !GATEWAY_A ||
    !CLOUD_TEST_B ||
    !CLOUD_TEST_DATABASE_URL ||
    !CLOUD_TEST_REDIS_URL
  ) {
    skip()

    return
  }

  const owner = await startOwner(CLOUD_TEST_DATABASE_URL, CLOUD_TEST_REDIS_URL)
  const CLOUD_TEST_A = owner.url
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
        subject: "Week 5 failover",
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
    const host = await connect(CLOUD_TEST_B, hostToken)
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
    const {
      rows: [before],
    } = await pool.query<{
      owner_token: string
      owner_epoch: number
      closes_at: Date
    }>(
      "SELECT owner_token, owner_epoch, closes_at FROM rooms JOIN rounds ON rounds.room_id = rooms.id WHERE rounds.id = $1",
      [roundId],
    )
    owner.process.kill("SIGKILL")
    await expect
      .poll(
        async () => {
          const {
            rows: [room],
          } = await pool.query<{ owner_epoch: number }>(
            "SELECT owner_epoch FROM rooms WHERE id = $1",
            [gameId],
          )

          return room.owner_epoch
        },
        { timeout: 12000 },
      )
      .toBe(before.owner_epoch + 1)
    const {
      rows: [after],
    } = await pool.query<{ owner_token: string; closes_at: Date }>(
      "SELECT owner_token, closes_at FROM rooms JOIN rounds ON rounds.room_id = rooms.id WHERE rounds.id = $1",
      [roundId],
    )
    expect(after.owner_token).not.toBe(before.owner_token)
    expect(after.closes_at).toEqual(before.closes_at)
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
    const resumed = await connect(GATEWAY_A, first.session.token)
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
    const {
      rows: [closed],
    } = await pool.query<{ closed_at: Date }>(
      "SELECT closed_at FROM rounds WHERE id = $1",
      [roundId],
    )
    expect(closed.closed_at).toBeInstanceOf(Date)
    const {
      rows: [finalRoom],
    } = await pool.query<{ status: string }>(
      "SELECT status FROM rooms WHERE id = $1",
      [gameId],
    )
    expect(finalRoom.status).toBe("finished")
    const metrics = await (await fetch(`${CLOUD_TEST_B}/metrics`)).text()
    expect(metrics).toContain("razzia_answer_ack_seconds_count")
    const { results } = (await json(CLOUD_TEST_B, "/api/results", {
      token: hostToken,
    })) as { results: Array<{ id: string; subject: string }> }
    const saved = results.find((entry) => entry.subject === "Week 5 failover")
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
    await delay(1100)
    const finishedHost = await connect(CLOUD_TEST_B, hostToken)
    const finalHostSnapshot = nextEvent(
      finishedHost,
      EVENTS.MANAGER.SUCCESS_RECONNECT,
    )
    finishedHost.emit(EVENTS.MANAGER.RECONNECT, { gameId })
    await expect(finalHostSnapshot).resolves.toMatchObject({
      status: { name: STATUS.FINISHED },
      players: [{ points: 1 }, { points: 1 }],
    })

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
    owner.process.kill()
    await rm(owner.directory, { recursive: true, force: true })
  }
}, 45000)

interface RecoveryRow {
  id: string
  name: string
  status: string
  owner_epoch: number
  stage_deadline: Date | null
  auto_advance_at: Date | null
  closes_at: Date | null
  closed_at: Date | null
  report: GameResult
}

it
  .skipIf(
    !GATEWAY_A ||
      !CLOUD_TEST_B ||
      !CLOUD_TEST_DATABASE_URL ||
      !CLOUD_TEST_REDIS_URL,
  )
  .each(["lobby", "prepared", "question", "open-gap", "expired", "results"])(
  "recovers the %s phase after coordinator termination",
  async (phase) => {
    if (
      !GATEWAY_A ||
      !CLOUD_TEST_B ||
      !CLOUD_TEST_DATABASE_URL ||
      !CLOUD_TEST_REDIS_URL
    ) {
      throw new Error("Cloud integration environment is missing")
    }

    const owner = await startOwner(
      CLOUD_TEST_DATABASE_URL,
      CLOUD_TEST_REDIS_URL,
    )
    const pool = new Pool({ connectionString: CLOUD_TEST_DATABASE_URL })
    const sockets: Client[] = []
    const connect = async (token: string) => {
      const socket: Client = io(CLOUD_TEST_B, {
        path: "/ws",
        auth: { token },
        transports: ["websocket"],
        reconnection: false,
      })
      sockets.push(socket)
      await nextEvent(socket, "connect")

      return socket
    }
    let roomId: string | undefined = undefined

    try {
      const hostSession = (await json(owner.url, "/api/auth/manager", {
        data: { password: "test-password" },
      })) as SessionResponse
      const quiz = (await json(owner.url, "/api/quizz", {
        token: hostSession.token,
        data: {
          subject: `Recovery ${phase}`,
          gameMode: "quiz",
          questions: [
            {
              type: "single",
              question: "Keep deadline?",
              answers: ["Yes", "No"],
              solutions: [0],
              cooldown: phase === "question" ? 15 : 3,
              time: phase === "expired" ? 4 : 60,
            },
          ],
        },
      })) as { id: string }
      const created = (await json(owner.url, "/api/games", {
        token: hostSession.token,
        data: { quizzId: quiz.id },
      })) as { gameId: string; inviteCode: string }
      roomId = created.gameId
      const gameId = roomId
      const host = await connect(hostSession.token)
      const hostReady = nextEvent(host, EVENTS.MANAGER.SUCCESS_RECONNECT)
      host.emit(EVENTS.MANAGER.RECONNECT, { gameId })
      await hostReady
      await json(CLOUD_TEST_B, `/api/games/${gameId}/settings`, {
        token: hostSession.token,
        method: "PATCH",
        data: {
          answersOnly: true,
          autoAdvance: {
            enable: phase === "results",
            responsesDelay: 20,
            leaderboardDelay: 20,
          },
        },
      })
      const session = (await json(CLOUD_TEST_B, "/api/auth/session", {
        data: {},
      })) as SessionResponse
      const { ticket } = (await json(CLOUD_TEST_B, "/api/games/join", {
        token: session.token,
        data: { inviteCode: created.inviteCode, username: "Survivor" },
      })) as { ticket: string }
      const player = await connect(session.token)
      const joined = nextEvent(player, EVENTS.GAME.SUCCESS_JOIN)
      player.emit(EVENTS.PLAYER.LOGIN, { ticket })
      await joined
      const statuses: Array<{ name: string; data: unknown }> = []
      player.on(EVENTS.GAME.STATUS, (status) => {
        statuses.push(status)
      })

      if (phase !== "lobby") {
        let target: string = STATUS.SELECT_ANSWER

        if (phase === "prepared") {
          target = STATUS.SHOW_PREPARED
        }

        if (phase === "question") {
          target = STATUS.SHOW_QUESTION
        }

        host.emit(EVENTS.MANAGER.START_GAME, { gameId })
        await expect
          .poll(() => statuses.some((status) => status.name === target), {
            timeout: 12000,
            interval: 20,
          })
          .toBe(true)

        if (phase === "results") {
          const question = statuses.find(
            (status) => status.name === STATUS.SELECT_ANSWER,
          )?.data as { roundId: string }
          const accepted = nextEvent(player, EVENTS.PLAYER.ANSWER_ACK)
          player.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
            gameId,
            roundId: question.roundId,
            data: { answerKeys: [0] },
          })
          await expect(accepted).resolves.toMatchObject({ status: "accepted" })
          await applyScoreFixture(pool, gameId)
          await expect
            .poll(async () => {
              const {
                rows: [room],
              } = await pool.query<RecoveryRow>(
                "SELECT host_state->>'name' AS name FROM rooms WHERE id = $1",
                [gameId],
              )

              return room.name
            })
            .toBe(STATUS.SHOW_RESPONSES)
        }
      }

      if (phase === "open-gap") {
        await pool.query("UPDATE rooms SET runtime = $2 WHERE id = $1", [
          gameId,
          {
            name: STATUS.SHOW_QUESTION,
            data: { question: "Keep deadline?", cooldown: 3 },
          },
        ])
        statuses.length = 0
      }

      const {
        rows: [before],
      } = await pool.query<RecoveryRow>(
        "SELECT owner_epoch, stage_deadline, auto_advance_at FROM rooms WHERE id = $1",
        [gameId],
      )
      const {
        rows: [roundBefore],
      } = await pool.query<RecoveryRow>(
        "SELECT id, closes_at, closed_at FROM rounds WHERE room_id = $1",
        [gameId],
      )
      owner.process.kill("SIGKILL")
      await expect
        .poll(
          async () => {
            const {
              rows: [room],
            } = await pool.query<RecoveryRow>(
              "SELECT owner_epoch FROM rooms WHERE id = $1",
              [gameId],
            )

            return room.owner_epoch
          },
          { timeout: 12000 },
        )
        .toBe(before.owner_epoch + 1)
      // A command is routed only after snapshot hydration is complete.
      const hostRestored = nextEvent(host, EVENTS.MANAGER.SUCCESS_RECONNECT)
      host.emit(EVENTS.MANAGER.RECONNECT, { gameId })
      await expect(hostRestored).resolves.toMatchObject({
        gameId,
        settings: { answersOnly: true },
        players: [{ username: "Survivor" }],
      })
      const restored = nextEvent(player, EVENTS.PLAYER.SUCCESS_RECONNECT)
      player.emit(EVENTS.PLAYER.RECONNECT, { gameId })
      await expect(restored).resolves.toMatchObject({ gameId })

      if (phase === "lobby") {
        host.emit(EVENTS.MANAGER.START_GAME, { gameId })
        await expect
          .poll(
            () =>
              statuses.some((status) => status.name === STATUS.SELECT_ANSWER),
            { timeout: 12000 },
          )
          .toBe(true)
      } else if (phase === "expired") {
        await expect
          .poll(async () => {
            const {
              rows: [round],
            } = await pool.query<RecoveryRow>(
              "SELECT status FROM rounds WHERE id = $1",
              [roundBefore.id],
            )

            return round.status
          })
          .toBe("closed")
        const rejected = nextEvent(player, EVENTS.PLAYER.ANSWER_ACK)
        player.emit(EVENTS.PLAYER.SELECTED_ANSWER, {
          gameId,
          roundId: roundBefore.id,
          data: { answerKeys: [0] },
        })
        await expect(rejected).resolves.toMatchObject({ status: "closed" })
        const {
          rows: [round],
        } = await pool.query<RecoveryRow>(
          "SELECT closes_at, closed_at FROM rounds WHERE id = $1",
          [roundBefore.id],
        )
        expect(round.closes_at).toEqual(roundBefore.closes_at)
        await delay(150)
        const {
          rows: [again],
        } = await pool.query<RecoveryRow>(
          "SELECT closed_at FROM rounds WHERE id = $1",
          [roundBefore.id],
        )
        expect(again.closed_at).toEqual(round.closed_at)
      } else if (phase === "results") {
        const {
          rows: [restoredRoom],
        } = await pool.query<RecoveryRow>(
          "SELECT auto_advance_at FROM rooms WHERE id = $1",
          [gameId],
        )
        expect(restoredRoom.auto_advance_at).toEqual(before.auto_advance_at)
        const {
          rows: [round],
        } = await pool.query<RecoveryRow>(
          "SELECT closed_at FROM rounds WHERE id = $1",
          [roundBefore.id],
        )
        expect(round.closed_at).toEqual(roundBefore.closed_at)
        await expect
          .poll(
            async () => {
              const {
                rows: [room],
              } = await pool.query<RecoveryRow>(
                "SELECT status FROM rooms WHERE id = $1",
                [gameId],
              )

              return room.status
            },
            { timeout: 6000 },
          )
          .toBe("finished")
        const {
          rows: [report],
        } = await pool.query<RecoveryRow>(
          "SELECT report FROM game_reports WHERE room_id = $1",
          [gameId],
        )
        expect(report.report).toMatchObject({
          players: [{ points: 1, rank: 1 }],
        })
        expect(report.report.questions).toHaveLength(1)
      } else {
        await expect
          .poll(
            () =>
              statuses.some((status) => status.name === STATUS.SELECT_ANSWER),
            { timeout: 8000 },
          )
          .toBe(true)
      }

      const probes = await Promise.all(
        ["/health/live", "/health/ready", "/metrics"].map((path) =>
          fetch(CLOUD_TEST_B + path),
        ),
      )
      expect(probes.every((response) => response.ok)).toBe(true)
    } finally {
      if (roomId) {
        await pool.query<RecoveryRow>(
          "UPDATE rooms SET status = 'cancelled' WHERE id = $1 AND status IN ('lobby', 'running')",
          [roomId],
        )
      }

      sockets.forEach((socket) => {
        socket.disconnect()
      })
      owner.process.kill()
      await pool.end()
      await rm(owner.directory, { recursive: true, force: true })
    }
  },
  45000,
)
