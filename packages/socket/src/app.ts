import type { ServerType } from "@hono/node-server"
import { EVENTS } from "@razzia/common/constants"
import type { Server } from "@razzia/common/types/game/socket"
import { clientEventValidators } from "@razzia/common/validators/socket"
import { api } from "@razzia/socket/api"
import {
  gameSocketHandlers,
  installRoomRouting,
} from "@razzia/socket/handlers/game"
import type { SocketHandler } from "@razzia/socket/handlers/types"
import { verifyToken } from "@razzia/socket/services/auth"
import { cloud } from "@razzia/socket/services/cloud"
import { CloudGame } from "@razzia/socket/services/cloud-game"
import { DomainError } from "@razzia/socket/services/errors"
import { metrics } from "@razzia/socket/services/metrics"
import { setIo } from "@razzia/socket/services/io"
import { createAdapter } from "@socket.io/redis-adapter"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { JwtTokenExpired } from "hono/utils/jwt/types"
import { StatusCodes } from "http-status-codes"
import { Server as ServerIO } from "socket.io"
import { z } from "zod"

const eventValidators: Partial<Record<string, z.ZodType>> =
  clientEventValidators

export const app = new Hono()

app.get("/health/live", (c) => c.json({ status: "ok" }))
app.get("/health/ready", async (c) => {
  if (cloud && !(await cloud.ready())) {
    return c.json({ status: "unavailable" }, StatusCodes.SERVICE_UNAVAILABLE)
  }

  return c.json({ status: "ok" })
})
app.get("/metrics", (c) =>
  c.text(metrics.render(), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  }),
)
app.route("/api", api)

app.notFound((c) =>
  c.json({ error: "errors:api.notFound" }, StatusCodes.NOT_FOUND),
)

const HTTP_ERROR_KEYS: Partial<Record<number, string>> = {
  [StatusCodes.BAD_REQUEST]: "errors:invalidRequest",
  [StatusCodes.UNAUTHORIZED]: "errors:auth.unauthorized",
  [StatusCodes.FORBIDDEN]: "errors:auth.unauthorized",
  [StatusCodes.NOT_FOUND]: "errors:api.notFound",
}

app.onError((error, c) => {
  if (error instanceof DomainError) {
    if (error.status >= StatusCodes.INTERNAL_SERVER_ERROR) {
      console.error("API error:", error)
    }

    return c.json({ error: error.key }, error.status)
  }

  if (error instanceof HTTPException) {
    return c.json(
      { error: HTTP_ERROR_KEYS[error.status] ?? "errors:api.serverError" },
      error.status,
    )
  }

  console.error("Unhandled API error:", error)

  return c.json(
    { error: "errors:api.serverError" },
    StatusCodes.INTERNAL_SERVER_ERROR,
  )
})

const socketHandlers: SocketHandler[] = [gameSocketHandlers]

const authError = (code: string, message: string) => {
  const error = new Error(message) as Error & { data: { code: string } }
  error.data = { code }

  return error
}

export const createSocketServer = (server: ServerType): Server => {
  const io: Server = new ServerIO(server, {
    path: "/ws",
    ...(cloud && { transports: ["websocket"] }),
  })

  if (cloud) {
    io.adapter(
      createAdapter(cloud.redis, cloud.subscriber, {
        publishOnSpecificResponseChannel: true,
      }),
    )
    installRoomRouting(io)
    const storage = cloud
    void storage.subscriber
      .subscribe("razzia:leaderboard", (message) => {
        try {
          const notification: unknown = JSON.parse(message)
          const result = z.object({ room_id: z.uuid() }).safeParse(notification)

          if (!result.success) {
            return
          }

          const roomId = result.data.room_id
          void new CloudGame(storage, roomId)
            .scores(0)
            .then((scores) => {
              io.local.to(roomId).emit(EVENTS.PLAYER.UPDATE_LEADERBOARD, {
                leaderboard: scores.filter((player) => player.active),
              })
            })
            .catch((error: unknown) =>
              console.error("Leaderboard read failed:", error),
            )
        } catch (error) {
          console.error("Invalid leaderboard notification:", error)
        }
      })
      .catch((error: unknown) =>
        console.error("Leaderboard subscription failed:", error),
      )
  }

  setIo(io)

  io.use((socket, next) => {
    const token = socket.handshake.auth.token as string | undefined

    if (!token) {
      next(authError("TOKEN_MISSING", "errors:auth.tokenMissing"))

      return
    }

    verifyToken(token)
      .then((claims) => {
        socket.data = {
          clientId: claims.sub,
          role: claims.role,
        }

        next()
      })
      .catch((error: unknown) => {
        const code =
          error instanceof JwtTokenExpired ? "TOKEN_EXPIRED" : "TOKEN_INVALID"

        next(authError(code, "errors:auth.tokenInvalid"))
      })
  })

  io.on("connection", (socket) => {
    metrics.connections += 1
    socket.once("disconnect", () => {
      metrics.connections -= 1
    })
    console.log(
      `A user connected: socketId: ${socket.id}, clientId: ${socket.data.clientId}`,
    )

    socket.use((packet, next) => {
      const validator = eventValidators[packet[0]]

      if (!validator) {
        next()

        return
      }

      const result = validator.safeParse(packet[1])

      if (!result.success) {
        socket.emit(EVENTS.GAME.ERROR_MESSAGE, "errors:invalidRequest")

        return
      }

      packet[1] = result.data
      next()
    })

    socketHandlers.forEach((handler) => {
      handler({ io, socket })
    })
  })

  return io
}
