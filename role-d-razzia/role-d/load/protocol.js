/** Socket.IO v4 over Engine.IO v4, websocket only. No socket.io-client dependency.
 *  Razzia 4.0.2 connects at path /ws with auth { token }.
 *  Plain ESM so both Node and k6 can import it.
 */

export function engineUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/"
  url.search = "EIO=4&transport=websocket"
  url.hash = ""
  return url.toString()
}

export function encodeConnect(auth) {
  return `40${JSON.stringify(auth)}`
}

export function encodeEvent(event, payload) {
  return `42${JSON.stringify([event, payload])}`
}

export function parseEnginePacket(message) {
  if (typeof message !== "string" || message.length === 0) {
    return { kind: "ignored" }
  }

  const engineType = message[0]
  const rest = message.slice(1)

  if (engineType === "0") {
    return { kind: "open", payload: JSON.parse(rest) }
  }

  if (engineType === "2") {
    return { kind: "ping" }
  }

  if (engineType === "3") {
    return { kind: "pong" }
  }

  if (engineType === "4") {
    return { kind: "message", packet: parseSocketPacket(rest) }
  }

  return { kind: "ignored", engineType }
}

export function parseSocketPacket(packet) {
  const type = packet[0]
  let rest = packet.slice(1)
  let namespace = "/"

  if (rest.startsWith("/")) {
    const comma = rest.indexOf(",")

    if (comma === -1) {
      namespace = rest
      rest = ""
    } else {
      namespace = rest.slice(0, comma)
      rest = rest.slice(comma + 1)
    }
  }

  const ack = /^(\d+)/.exec(rest)
  let ackId = null

  if (ack) {
    ackId = Number(ack[1])
    rest = rest.slice(ack[1].length)
  }

  return {
    type,
    namespace,
    ackId,
    data: rest ? JSON.parse(rest) : null,
  }
}

export function pongFor(packet) {
  return packet.kind === "ping" ? "3" : null
}
