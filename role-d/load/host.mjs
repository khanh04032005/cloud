import { readFile, writeFile } from "node:fs/promises"
import {
  encodeConnect,
  encodeEvent,
  engineUrl,
  parseEnginePacket,
  pongFor,
} from "./protocol.js"

const HELP = `Host Razzia 4.0.2 cho k6. Giữ kết nối manager, mở phòng, đóng từng câu.

Bắt buộc:
  BASE_URL=https://quiz.example.com
  MANAGER_PASSWORD=...
  QUIZ_FILE=questions/out/opentrivia-load.json

Tuỳ chọn:
  ROOMS=1
  EXPECTED_PLAYERS=100     tổng người, chia đều cho các phòng
  WAIT_MS=90000            hết giờ thì bắt đầu với số người hiện có
  ADVANCE_DELAY_MS=400     nghỉ giữa màn đáp án và leaderboard
  CODES_FILE=invite-codes.json

In INVITE_CODES=... ngay khi phòng được tạo. Chạy k6 với chuỗi đó
trong lúc process này còn sống. Không tắt host giữa chừng: manager
ngắt kết nối trước lúc bắt đầu sẽ huỷ phòng.
`

function env(name, fallback = "") {
  return process.env[name] ?? fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(baseUrl, pathname, body, token) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`${response.status} ${pathname} ${text}`)
  }

  return text ? JSON.parse(text) : null
}

function connectManager(baseUrl, token) {
  const ws = new WebSocket(engineUrl(baseUrl))
  const listeners = new Map()

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("manager socket timeout")), 15000)

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("manager websocket error"))
    })

    ws.addEventListener("message", (event) => {
      const packet = parseEnginePacket(String(event.data))
      const pong = pongFor(packet)

      if (pong) {
        ws.send(pong)
      }

      if (packet.kind === "open") {
        ws.send(encodeConnect({ token }))
        return
      }

      if (packet.kind !== "message") {
        return
      }

      if (packet.packet.type === "0") {
        clearTimeout(timer)
        resolve()
        return
      }

      if (packet.packet.type === "4") {
        clearTimeout(timer)
        reject(new Error(`manager connect refused ${JSON.stringify(packet.packet.data)}`))
        return
      }

      if (packet.packet.type === "2" && Array.isArray(packet.packet.data)) {
        const [name, payload] = packet.packet.data
        listeners.get(name)?.(payload)
      }
    })
  })

  return {
    ready,
    on(event, handler) {
      listeners.set(event, handler)
    },
    emit(event, payload) {
      ws.send(encodeEvent(event, payload))
    },
    close() {
      ws.close()
    },
  }
}

async function openRoom(baseUrl, token, quizId) {
  const created = await postJson(baseUrl, "/api/games", { quizzId: quizId }, token)
  const client = connectManager(baseUrl, token)
  await client.ready
  client.emit("manager:reconnect", { gameId: created.gameId })
  await sleep(200)

  return { ...created, client, players: 0 }
}

function watchRoom(room, { expected, waitMs, advanceDelay, maxGameMs }) {
  let advancing = false

  const finished = new Promise((resolve) => {
    room.client.on("game:totalPlayers", (count) => {
      room.players = Number(count) || 0
    })

    room.client.on("game:status", (status) => {
      if (!status?.name) {
        return
      }

      if (status.name === "FINISHED" || status.name === "SUMMARY") {
        resolve(room)
        return
      }

      if (advancing) {
        return
      }

      if (status.name !== "SHOW_RESPONSES" && status.name !== "SHOW_LEADERBOARD") {
        return
      }

      advancing = true
      setTimeout(() => {
        room.client.emit("manager:advance", { gameId: room.gameId })
        advancing = false
      }, advanceDelay)
    })
  })

  const starter = (async () => {
    const deadline = Date.now() + waitMs

    while (Date.now() < deadline && room.players < expected) {
      await sleep(500)
    }

    console.log(`start ${room.inviteCode} with ${room.players}/${expected} players`)
    room.client.emit("manager:setLock", { gameId: room.gameId, locked: true })
    room.client.emit("manager:startGame", { gameId: room.gameId })
  })()

  const cap = sleep(maxGameMs).then(() => {
    console.error(`timeout ${room.inviteCode} after ${maxGameMs}ms`)
  })

  return Promise.all([starter, Promise.race([finished, cap])]).then(() => room)
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(HELP)
    return
  }

  const baseUrl = env("BASE_URL")
  const password = env("MANAGER_PASSWORD")
  const quizFile = env("QUIZ_FILE")

  if (!baseUrl || !password || !quizFile) {
    console.error(HELP)
    process.exit(1)
  }

  const roomCount = Number(env("ROOMS", "1"))
  const expectedTotal = Number(env("EXPECTED_PLAYERS", "1"))
  const expectedEach = Math.ceil(expectedTotal / roomCount)
  const waitMs = Number(env("WAIT_MS", "90000"))
  const advanceDelay = Number(env("ADVANCE_DELAY_MS", "400"))
  const maxGameMs = Number(env("MAX_GAME_MS", "600000"))
  const codesFile = env("CODES_FILE", "invite-codes.json")
  const quiz = JSON.parse(await readFile(quizFile, "utf8"))

  const session = await postJson(baseUrl, "/api/auth/session", {})
  const manager = await postJson(
    baseUrl,
    "/api/auth/manager",
    { password },
    session.token,
  )
  const saved = await postJson(baseUrl, "/api/quizz", quiz, manager.token)
  const rooms = []

  for (let index = 0; index < roomCount; index += 1) {
    rooms.push(await openRoom(baseUrl, manager.token, saved.id))
  }

  const payload = {
    quizId: saved.id,
    inviteCodes: rooms.map((room) => room.inviteCode),
    gameIds: rooms.map((room) => room.gameId),
  }

  await writeFile(codesFile, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`INVITE_CODES=${payload.inviteCodes.join(",")}`)
  console.log(`wrote ${codesFile}`)

  const played = await Promise.all(
    rooms.map((room) =>
      watchRoom(room, { expected: expectedEach, waitMs, advanceDelay, maxGameMs }),
    ),
  )

  for (const room of played) {
    room.client.close()
    console.log(`finished ${room.inviteCode}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
