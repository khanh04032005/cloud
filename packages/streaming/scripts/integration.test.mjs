import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { Kafka, logLevel } from "kafkajs"
import {
  applyImportPlan,
  buildImportPlan,
} from "../../../role-d/lambda/import-questions/logic.mjs"
import {
  answersSql,
  assignRanks,
  hasScoreMismatch,
  resultsSql,
  readExportSnapshot,
} from "../../../role-d/lambda/export-results/logic.mjs"

const { io } = createRequire(
  new URL("../../socket/package.json", import.meta.url),
)("socket.io-client")
const required = (key) => {
  assert.ok(
    process.env[key],
    `Set ${key} to an isolated integration environment`,
  )
  return process.env[key]
}
const base = required("INTEGRATION_BASE_URL")
const pool = new pg.Pool({
  connectionString: required("INTEGRATION_DATABASE_URL"),
})
const kafka = new Kafka({
  clientId: "razzia-integration",
  brokers: required("INTEGRATION_KAFKA_BROKERS").split(","),
  logLevel: logLevel.ERROR,
})

async function json(
  path,
  token,
  data,
  method = data === undefined ? "GET" : "POST",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await response.json()
  assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`)
  return body
}
function next(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler)
      reject(new Error(`Timeout: ${name}`))
    }, 60000)
    function handler(value) {
      if (!predicate(value)) {
        return
      }
      clearTimeout(timer)
      socket.off(name, handler)
      resolve(value)
    }
    socket.on(name, handler)
  })
}
function hasReachedOffsets(target, offsets) {
  return target.every(({ partition, offset }) => {
    const committed = BigInt(
      offsets.find((entry) => entry.partition === partition)?.offset ?? "-1",
    )
    // An empty partition has no committed offset (-1), but no lag.
    return committed >= (BigInt(offset) === 0n ? -1n : BigInt(offset))
  })
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return
    }
    await delay(100)
  }
  throw new Error("Integration condition did not complete within 20 seconds")
}

test(
  "import → game across gateways → real Kafka scoring → replay → export/audit",
  { timeout: 120000 },
  async (t) => {
    const sockets = []
    const timers = new Set()
    const producer = kafka.producer()
    const admin = kafka.admin()
    t.after(async () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      for (const socket of sockets) {
        socket.disconnect()
      }
      await Promise.allSettled([
        producer.disconnect(),
        admin.disconnect(),
        pool.end(),
      ])
    })
    const client = await pool.connect()
    const quiz = {
      gameMode: "quiz",
      subject: `Kafka integration ${Date.now()}`,
      questions: [0, 1].map((solution, index) => ({
        type: "single",
        question: `Question ${index + 1}`,
        answers: ["A", "B"],
        solutions: [solution],
        cooldown: 3,
        time: 5,
        maxPoints: 1,
      })),
    }
    const source = {
      bucket: "integration",
      key: `${quiz.subject}.json`,
      etag: "v1",
      body: Buffer.from(JSON.stringify(quiz)),
      license: "CC BY-SA 4.0",
    }
    let imported
    try {
      imported = await applyImportPlan(client, buildImportPlan(source))
      assert.equal(
        (await applyImportPlan(client, buildImportPlan(source))).status,
        "duplicate",
      )
    } finally {
      client.release()
    }

    const { token: hostToken } = await json("/api/auth/manager", null, {
      password: process.env.INTEGRATION_MANAGER_PASSWORD ?? "admin",
    })
    const catalog = await json(`/api/quizz/${imported.quizId}`, hostToken)
    assert.equal(catalog.questions.length, 2)
    const { gameId, inviteCode } = await json("/api/games", hostToken, {
      quizzId: imported.quizId,
    })
    const history = async () =>
      (
        await pool.query(
          "SELECT id, position, question_snapshot FROM rounds WHERE room_id = $1 ORDER BY position",
          [gameId],
        )
      ).rows
    const originalHistory = await history()
    const edited = {
      ...quiz,
      subject: `${quiz.subject} edited`,
      questions: quiz.questions.map((question) => ({
        ...question,
        question: "Edited question",
        solutions: [(question.solutions[0] + 1) % 2],
      })),
    }
    await json(`/api/quizz/${imported.quizId}`, hostToken, edited, "PATCH")
    assert.equal(
      (await json(`/api/quizz/${imported.quizId}`, hostToken)).subject,
      edited.subject,
    )
    assert.deepEqual(await history(), originalHistory)
    const connect = async (url, token) => {
      const socket = io(url, {
        path: "/ws",
        transports: ["websocket"],
        auth: { token },
        reconnection: false,
        autoConnect: false,
      })
      sockets.push(socket)
      const ready = next(socket, "connect")
      socket.connect()
      await ready
      return socket
    }
    const host = await connect(
      process.env.INTEGRATION_SOCKET_A ?? base,
      hostToken,
    )
    const hostReady = next(host, "manager:successReconnect")
    host.emit("manager:reconnect", { gameId })
    await hostReady
    const players = []
    for (const name of ["correct", "wrong"]) {
      const { token } = await json("/api/auth/session", null, {})
      const { ticket } = await json("/api/games/join", token, {
        inviteCode,
        username: name,
      })
      const socket = await connect(
        process.env.INTEGRATION_SOCKET_B ?? base,
        token,
      )
      const ready = next(socket, "game:successJoin")
      socket.emit("player:login", { ticket })
      await ready
      players.push({ name, socket })
    }
    const acks = []
    const notifications = []
    const submitted = new Set()
    const asyncErrors = []
    for (const player of players) {
      player.socket.on("player:updateLeaderboard", (value) =>
        notifications.push(value),
      )
      player.socket.on("game:status", async (status) => {
        if (status.name !== "SELECT_ANSWER") {
          return
        }
        const { roundId, answers } = status.data
        const key = `${player.name}:${roundId}`
        if (submitted.has(key)) {
          return
        }
        submitted.add(key)
        try {
          const round = await pool.query(
            "SELECT position FROM rounds WHERE id = $1",
            [roundId],
          )
          const correct =
            quiz.questions[round.rows[0].position - 1].solutions[0]
          const choice =
            player.name === "correct" ? correct : (correct + 1) % answers.length
          const accepted = next(
            player.socket,
            "player:answerAck",
            (value) => value.roundId === roundId,
          )
          player.socket.emit("player:selectedAnswer", {
            gameId,
            roundId,
            data: { answerKeys: [choice] },
          })
          const receipt = await accepted
          assert.equal(receipt.status, "accepted")
          acks.push(receipt)
          if (player.name === "correct") {
            const duplicate = next(
              player.socket,
              "player:answerAck",
              (value) => value.roundId === roundId,
            )
            player.socket.emit("player:selectedAnswer", {
              gameId,
              roundId,
              data: { answerKeys: [(choice + 1) % answers.length] },
            })
            const retry = await duplicate
            assert.equal(retry.status, "duplicate")
            assert.deepEqual(retry.answerKeys, [choice])
          }
        } catch (error) {
          asyncErrors.push(error)
        }
      })
    }
    host.on("game:status", ({ name }) => {
      if (!["SHOW_RESPONSES", "SHOW_LEADERBOARD"].includes(name)) {
        return
      }
      const timer = setTimeout(() => {
        timers.delete(timer)
        host.emit("manager:advance", { gameId })
      }, 200)
      timers.add(timer)
    })
    const finished = players.map(({ socket }) =>
      next(socket, "game:status", ({ name }) => name === "FINISHED"),
    )
    host.emit("manager:setLock", { gameId, locked: true })
    host.emit("manager:startGame", { gameId })
    await Promise.all(finished)
    assert.deepEqual(asyncErrors, [])
    assert.equal(acks.length, 4)
    assert.ok(
      notifications.length > 0,
      "B must publish the channel consumed by A",
    )
    const report = (
      await pool.query("SELECT report FROM game_reports WHERE room_id = $1", [
        gameId,
      ])
    ).rows[0].report
    assert.deepEqual(report.players.map(({ points }) => points).sort(), [0, 2])
    assert.equal(report.subject, quiz.subject)
    await json(
      `/api/quizz/${imported.quizId}`,
      hostToken,
      { ...edited, subject: "Edited after game finished" },
      "PATCH",
    )
    assert.deepEqual(await history(), originalHistory)
    assert.deepEqual(
      (
        await pool.query("SELECT report FROM game_reports WHERE room_id = $1", [
          gameId,
        ])
      ).rows[0].report,
      report,
    )

    const exported = await pool.query(answersSql(gameId).text, [gameId])
    assert.equal(exported.rows.length, 4)
    assert.ok(exported.rows.every(({ event_id }) => event_id))
    const exportClient = await pool.connect()
    let snapshot
    try {
      snapshot = await readExportSnapshot(exportClient, gameId)
    } finally {
      exportClient.release()
    }
    const scores = { rows: snapshot.scores }
    assert.equal(snapshot.answers.length, 4)
    assert.equal(scores.rows.filter(hasScoreMismatch).length, 0)
    assert.deepEqual(
      assignRanks(scores.rows).map(({ points, rank }) => [points, rank]),
      [
        [2, 1],
        [0, 2],
      ],
    )

    // Deliver the same durable events again through Kafka, exercising the real consumers.
    await producer.connect()
    await admin.connect()
    const messages = exported.rows.map((row) => ({
      key: gameId,
      value: JSON.stringify({
        ...row,
        accepted_at: row.accepted_at.toISOString(),
      }),
    }))
    await producer.send({
      topic: "answers",
      acks: -1,
      messages: [...messages, ...messages],
    })
    const target = await admin.fetchTopicOffsets("answers")
    await until(async () => {
      for (const groupId of ["razzia-score", "razzia-stats"]) {
        const groups = await admin.fetchOffsets({
          groupId,
          topics: ["answers"],
        })
        const offsets = groups[0].partitions
        if (!hasReachedOffsets(target, offsets)) {
          return false
        }
      }
      return true
    })
    assert.deepEqual(
      (await pool.query(resultsSql(gameId).text, [gameId])).rows,
      scores.rows,
    )
    const stats = await pool.query(
      "SELECT sum(answer_count)::int AS n FROM answer_rate_buckets WHERE room_id = $1",
      [gameId],
    )
    assert.equal(stats.rows[0].n, 4)
    const legacy = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('player_scores', 'score_processed_events', 'question_sets')",
    )
    assert.equal(legacy.rows.length, 0)
    console.log(
      JSON.stringify({
        gameId,
        quizId: imported.quizId,
        finished: true,
        acceptedAnswers: acks.length,
        kafkaReplayMessages: messages.length * 2,
        points: [2, 0],
        statsCount: stats.rows[0].n,
        auditMismatches: 0,
        legacyTables: 0,
      }),
    )
  },
)
