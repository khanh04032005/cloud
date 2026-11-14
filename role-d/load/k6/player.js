import http from "k6/http"
import ws from "k6/ws"
import { check, sleep } from "k6"
import { Counter, Rate, Trend } from "k6/metrics"
import {
  encodeConnect,
  encodeEvent,
  engineUrl,
  parseEnginePacket,
  pongFor,
} from "../protocol.js"

const joinMs = new Trend("join_ms", true)
const ackMs = new Trend("answer_ack_ms", true)
const reconnectMs = new Trend("reconnect_ms", true)
const accepted = new Counter("answers_accepted")
const sent = new Counter("answers_sent")
const duplicates = new Counter("duplicate_submissions")
const duplicateAcks = new Counter("duplicate_acks")
const failures = new Rate("player_failures")

const BASE = __ENV.BASE_URL
const CODES = (__ENV.INVITE_CODES || "")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean)
const MODE = __ENV.ANSWER_MODE || "random"
const SCENARIO = __ENV.SCENARIO || "play"
const RECONNECT_EVERY = Number(__ENV.RECONNECT_EVERY || 10)
const SOCKET_MS = Number(__ENV.SOCKET_MS || 180000)

function stages() {
  if (!__ENV.STAGES) {
    return null
  }

  return __ENV.STAGES.split(",").map((part) => {
    const [duration, target] = part.split(":")
    return { duration, target: Number(target) }
  })
}

const ramp = stages()
const stats = ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"]

export const options = ramp
  ? {
      scenarios: {
        players: {
          executor: "ramping-vus",
          stages: ramp,
          gracefulStop: "30s",
        },
      },
      summaryTrendStats: stats,
    }
  : {
      scenarios: {
        players: {
          executor: "constant-vus",
          vus: Number(__ENV.PLAYERS || 20),
          duration: __ENV.DURATION || "3m",
          gracefulStop: "30s",
        },
      },
      summaryTrendStats: stats,
    }

function noteFailure(message) {
  failures.add(1)
  console.error(message)
}

function answerDelay(timeSeconds) {
  const windowMs = Math.max(1, Number(timeSeconds) || 10) * 1000

  if (MODE === "immediate") {
    return 50
  }

  if (MODE === "end") {
    return Math.max(0, windowMs - 1500)
  }

  return Math.floor(Math.random() * windowMs * 0.7)
}

function postJson(pathname, body, token, name) {
  const response = http.post(`${BASE}${pathname}`, JSON.stringify(body ?? {}), {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    tags: { name },
  })

  return response
}

function runSocket(opts) {
  let opened = false
  let reconnected = false
  let shouldReconnect = false

  const response = ws.connect(engineUrl(BASE), {}, (socket) => {
    const answered = new Set()
    let questionKey = 0
    let ackAt = 0
    let acks = 0
    let choice = 0

    socket.on("message", (raw) => {
      const packet = parseEnginePacket(String(raw))
      const pong = pongFor(packet)

      if (pong) {
        socket.send(pong)
      }

      if (packet.kind === "open") {
        socket.send(encodeConnect({ token: opts.token }))
        return
      }

      if (packet.kind !== "message") {
        return
      }

      if (packet.packet.type === "0") {
        opened = true

        if (opts.reconnect) {
          socket.send(encodeEvent("player:reconnect", { gameId: opts.gameId }))
        } else if (opts.ticket) {
          socket.send(encodeEvent("player:login", { ticket: opts.ticket }))
        }

        return
      }

      if (packet.packet.type !== "2" || !Array.isArray(packet.packet.data)) {
        return
      }

      const [event, payload] = packet.packet.data

      if (event === "game:reset") {
        console.error(`reset ${payload}`)
        socket.close()
        return
      }

      if (event === "player:successReconnect") {
        reconnected = true
        opts.onReconnected?.()
      }

      if (event === "game:updateQuestion" && payload?.current) {
        questionKey = payload.current
      }

      if (event === "game:status" && payload?.name === "SELECT_ANSWER") {
        const key = questionKey || answered.size + 1

        if (answered.has(key)) {
          return
        }

        answered.add(key)
        choice = Math.floor(Math.random() * (payload.data.answers?.length || 1))

        socket.setTimeout(() => {
          ackAt = Date.now()
          acks = 0
          sent.add(1)
          socket.send(
            encodeEvent("player:selectedAnswer", {
              gameId: opts.gameId,
              data: { answerKeys: [choice] },
            }),
          )

          if (opts.duplicate) {
            socket.setTimeout(() => {
              duplicates.add(1)
              sent.add(1)
              socket.send(
                encodeEvent("player:selectedAnswer", {
                  gameId: opts.gameId,
                  data: { answerKeys: [choice] },
                }),
              )
            }, 300)
          }
        }, answerDelay(payload.data?.time))
      }

      if (
        event === "game:status" &&
        payload?.name === "WAIT" &&
        payload.data?.text === "game:waitingForAnswers"
      ) {
        acks += 1

        if (acks === 1) {
          ackMs.add(Date.now() - ackAt)
          accepted.add(1)
          shouldReconnect = true

          if (opts.stopAfterFirstAnswer) {
            socket.setTimeout(() => socket.close(), 200)
          }
        } else {
          duplicateAcks.add(1)
        }
      }

      if (
        event === "game:status" &&
        (payload?.name === "FINISHED" || payload?.name === "SUMMARY")
      ) {
        socket.close()
      }
    })

    socket.on("error", (err) => {
      noteFailure(`ws ${err.error()}`)
    })

    socket.setTimeout(() => socket.close(), SOCKET_MS)
  })

  const connected = response && response.status === 101 && opened
  return { connected, reconnected, shouldReconnect }
}

export default function () {
  if (!BASE || CODES.length === 0) {
    noteFailure("Cần BASE_URL và INVITE_CODES")
    sleep(1)
    return
  }

  const inviteCode = CODES[(__VU - 1) % CODES.length]
  const session = postJson("/api/auth/session", {}, null, "session")

  if (!check(session, { "session 200": (res) => res.status === 200 })) {
    noteFailure(`session ${session.status} ${session.body}`)
    return
  }

  const auth = session.json()
  const started = Date.now()
  const join = postJson(
    "/api/games/join",
    { inviteCode, username: `p${__VU}` },
    auth.token,
    "join",
  )
  joinMs.add(Date.now() - started)

  if (!check(join, { "join 200": (res) => res.status === 200 })) {
    noteFailure(`join ${join.status} ${join.body}`)
    return
  }

  const seat = join.json()
  const wantReconnect = SCENARIO === "reconnect" && __VU % RECONNECT_EVERY === 0
  const first = runSocket({
    token: auth.token,
    ticket: seat.ticket,
    gameId: seat.gameId,
    duplicate: SCENARIO === "duplicate",
    stopAfterFirstAnswer: wantReconnect,
  })

  if (!first.connected) {
    noteFailure(`socket không vào phòng ${inviteCode}`)
    return
  }

  if (!wantReconnect || !first.shouldReconnect) {
    return
  }

  const refreshed = postJson("/api/auth/session", { token: auth.token }, null, "refresh")
  const token = refreshed.status === 200 ? refreshed.json().token : auth.token
  const mark = Date.now()
  const second = runSocket({
    token,
    gameId: seat.gameId,
    reconnect: true,
    onReconnected() {
      reconnectMs.add(Date.now() - mark)
    },
  })

  if (!second.reconnected) {
    noteFailure(`reconnect thất bại ${seat.gameId}`)
  }
}
