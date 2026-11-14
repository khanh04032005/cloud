import assert from "node:assert/strict"
import test from "node:test"
import {
  encodeConnect,
  encodeEvent,
  engineUrl,
  parseEnginePacket,
  pongFor,
} from "./protocol.js"

test("builds the Razzia websocket url", () => {
  assert.equal(
    engineUrl("https://quiz.example.com/manager"),
    "wss://quiz.example.com/ws/?EIO=4&transport=websocket",
  )
})

test("encodes connect auth and player events", () => {
  assert.equal(encodeConnect({ token: "abc" }), '40{"token":"abc"}')
  assert.equal(
    encodeEvent("player:selectedAnswer", {
      gameId: "g1",
      data: { answerKeys: [1] },
    }),
    '42["player:selectedAnswer",{"gameId":"g1","data":{"answerKeys":[1]}}]',
  )
})

test("parses open, ping and game status", () => {
  const open = parseEnginePacket('0{"sid":"s","pingInterval":25000}')
  assert.equal(open.kind, "open")
  assert.equal(open.payload.sid, "s")

  const ping = parseEnginePacket("2")
  assert.equal(pongFor(ping), "3")

  const status = parseEnginePacket(
    '42["game:status",{"name":"WAIT","data":{"text":"game:waitingForAnswers"}}]',
  )
  assert.equal(status.packet.type, "2")
  assert.equal(status.packet.data[0], "game:status")
  assert.equal(status.packet.data[1].name, "WAIT")
})
