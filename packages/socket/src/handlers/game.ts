import { EVENTS } from "@razzia/common/constants"
import type { GameSettings } from "@razzia/common/types/game"
import type {
  ClientToServerEvents,
  Server,
  SocketData,
} from "@razzia/common/types/game/socket"
import type { GameSocket, SocketContext } from "@razzia/socket/handlers/types"
import { verifyJoinTicket } from "@razzia/socket/services/auth"
import { cloud } from "@razzia/socket/services/cloud"
import Game from "@razzia/socket/services/game"
import { getIo } from "@razzia/socket/services/io"
import Registry from "@razzia/socket/services/registry"
import { withManagerGame, withPlayerGame } from "@razzia/socket/utils/game"
import { getClientId } from "@razzia/socket/utils/socket"

type Event = Exclude<keyof ClientToServerEvents, "disconnect">
type Handler<E extends Event> = (
  ..._args: Parameters<ClientToServerEvents[E]>
) => unknown
type Register = <E extends Event>(_event: E, _handler: Handler<E>) => void

const checkJoinTicket = async (ticket: string, socket: GameSocket) => {
  const claims = await verifyJoinTicket(ticket).catch(() => null)

  if (!claims) {
    socket.emit(EVENTS.GAME.RESET, "errors:auth.joinTicketInvalid")

    return null
  }

  if (claims.sub !== getClientId(socket)) {
    socket.emit(EVENTS.GAME.RESET, "errors:auth.unauthorized")

    return null
  }

  return claims
}

const bindGameHandlers = (io: Server, socket: GameSocket, on: Register) => {
  const registry = Registry.getInstance()
  const clientId = getClientId(socket)

  const closeLobby = (game: Game) => {
    game.abortCooldown()
    io.to(game.gameId).emit(
      EVENTS.GAME.RESET,
      "errors:game.managerDisconnected",
    )
    registry.removeGame(game.gameId)
  }

  const handleManagerLeave = (game: Game) => {
    game.setManagerDisconnected()
    registry.markGameAsEmpty(game)

    if (!game.started) {
      closeLobby(game)
    }
  }

  const handleManagerDisconnect = (game: Game) => {
    game.setManagerDisconnected()
    registry.markGameAsEmpty(game)

    if (!game.started) {
      game.waitForManager(() => closeLobby(game))
    }
  }

  const handlePlayerLeave = (game: Game) => {
    if (!game.started) {
      const player = game.removePlayer(socket.id)

      if (player) {
        console.log(`Player ${player.username} left game ${game.gameId}`)
      }

      return
    }

    game.setPlayerDisconnected(socket.id)
  }

  on(EVENTS.PLAYER.RECONNECT, ({ gameId }) => {
    const game = registry.getPlayerGame(gameId, clientId)

    if (game) {
      game.reconnect(socket)

      return
    }

    socket.emit(EVENTS.GAME.RESET, "errors:game.notFound")
  })

  on(EVENTS.MANAGER.RECONNECT, ({ gameId }) => {
    const game = registry.getManagerGame(gameId, clientId)

    if (game) {
      game.reconnect(socket)

      return
    }

    socket.emit(EVENTS.GAME.RESET, "errors:game.expired")
  })

  on(EVENTS.PLAYER.LOGIN, async ({ ticket }) => {
    const claims = await checkJoinTicket(ticket, socket)

    if (!claims) {
      return
    }

    const game = registry.getGameById(claims.gameId)

    if (!game) {
      socket.emit(EVENTS.GAME.RESET, "errors:game.notFound")

      return
    }

    const error = await game.join(socket, claims.username)

    if (error) {
      socket.emit(EVENTS.GAME.RESET, error)
    }
  })

  on(EVENTS.MANAGER.KICK_PLAYER, ({ gameId, playerId }) =>
    withManagerGame(gameId, socket, (game) => game.kickPlayer(playerId)),
  )

  on(EVENTS.MANAGER.SET_LOCK, ({ gameId, locked }) =>
    withManagerGame(gameId, socket, (game) => game.setLocked(locked)),
  )

  on(EVENTS.MANAGER.START_GAME, ({ gameId }) =>
    withManagerGame(gameId, socket, (game) => game.start(socket)),
  )

  on(EVENTS.PLAYER.SELECTED_ANSWER, ({ gameId, data }) =>
    withPlayerGame(gameId, socket, (game) =>
      game.selectAnswer(socket, data.answerKeys),
    ),
  )

  on(EVENTS.MANAGER.ADVANCE, ({ gameId }) =>
    withManagerGame(gameId, socket, (game) => game.advance()),
  )

  on(EVENTS.MANAGER.LEAVE, ({ gameId }) => {
    const game = registry.getManagerGame(gameId, clientId)

    if (game) {
      console.log(`Manager left game ${game.inviteCode}`)
      handleManagerLeave(game)
    }
  })

  on(EVENTS.PLAYER.LEAVE, ({ gameId }) => {
    const game = registry.getPlayerGame(gameId, clientId)

    if (game) {
      handlePlayerLeave(game)
    }
  })

  return (reason: string, gameId?: string) => {
    console.log(`A user disconnected : ${socket.id}`)

    const managerGame = gameId
      ? registry.getGameById(gameId)
      : registry.getGameByManagerSocketId(socket.id)

    if (managerGame?.manager.id === socket.id) {
      console.log(`Manager disconnected from game ${managerGame.inviteCode}`)
      handleManagerDisconnect(managerGame)

      return
    }

    const playerGame = gameId
      ? managerGame
      : registry.getGameByPlayerSocketId(socket.id)

    if (playerGame?.players.some(({ id }) => id === socket.id)) {
      playerGame.setPlayerDisconnected(socket.id, reason === "ping timeout")
    }
  }
}

type SocketCommand = {
  gameId: string
  socketId: string
  data: SocketData
} & (
  { event: Event; args: unknown[] } | { event: "disconnect"; reason: string }
)

type Command =
  | SocketCommand
  | {
      event: "settings"
      gameId: string
      clientId: string
      settings: Partial<GameSettings>
    }

type Reply =
  | { joined: boolean }
  | { settings: GameSettings }
  | "missing"
  | "started"
  | "failed"
const commands = new Map<string, Promise<unknown>>()
const rpc = "razzia:room-command"

const runCommand = (io: Server, command: Command, localSocket?: GameSocket) => {
  const previous = commands.get(command.gameId) ?? Promise.resolve()
  const work = previous
    .then(async (): Promise<Reply> => {
      const game = Registry.getInstance().getGameById(command.gameId)

      if (!game) {
        return "missing"
      }

      if (command.event === "settings") {
        if (game.manager.clientId !== command.clientId) {
          return "missing"
        }

        const previousSettings = game.settings

        if (!game.updateSettings(command.settings)) {
          return "started"
        }

        try {
          await cloud?.saveLobby(game)
        } catch (error) {
          game.updateSettings(previousSettings)
          throw error
        }

        return { settings: game.settings }
      }

      const { socketId, data } = command
      const socket: GameSocket = localSocket ?? {
        id: socketId,
        data,
        join: (room) => io.in(socketId).socketsJoin(room),
        to: (room) => io.to(room).except(socketId),
        emit: (event, ...args) => io.to(socketId).emit(event, ...args),
      }
      const callbacks = new Map<Event, (..._args: never[]) => unknown>()
      const disconnect = bindGameHandlers(io, socket, (event, handler) => {
        callbacks.set(event, handler)
      })

      if (command.event === "disconnect") {
        disconnect(command.reason, command.gameId)
      } else {
        await callbacks.get(command.event)?.(...(command.args as never[]))
      }

      if (
        command.event === EVENTS.MANAGER.KICK_PLAYER ||
        command.event === EVENTS.PLAYER.LEAVE
      ) {
        await cloud?.prunePlayers(game)
      }

      return {
        joined:
          game.manager.id === socketId ||
          game.players.some(({ id }) => id === socketId),
      }
    })
    .catch((error: unknown): Reply => {
      console.error(`Room command ${command.event} failed:`, error)

      return "failed"
    })
  commands.set(command.gameId, work)
  void work.then(() => {
    if (commands.get(command.gameId) === work) {
      commands.delete(command.gameId)
    }
  })

  return work
}

const routeCommand = async (
  io: Server,
  command: Command,
  socket?: GameSocket,
): Promise<Reply> => {
  const owner = await cloud?.owner(command.gameId)

  if (!owner) {
    return "missing"
  }

  if (owner === cloud?.nodeId) {
    return runCommand(io, command, socket)
  }

  const replies = (await io.serverSideEmitWithAck(
    rpc,
    owner,
    command,
  )) as Array<Reply | null>

  return replies.find((reply) => reply !== null) ?? "missing"
}

export const installRoomRouting = (io: Server) => {
  io.on(
    rpc,
    (owner: string, command: Command, ack: (_result: Reply | null) => void) => {
      if (owner !== cloud?.nodeId) {
        ack(null)
      } else {
        void runCommand(io, command).then(ack)
      }
    },
  )
}

export const updateCloudRoomSettings = (
  gameId: string,
  clientId: string,
  settings: Partial<GameSettings>,
) => routeCommand(getIo(), { event: "settings", gameId, clientId, settings })

export const gameSocketHandlers = ({ io, socket }: SocketContext) => {
  // Socket.IO's reserved-event overload cannot narrow a generic application event.
  const register = socket.on.bind(socket) as Register

  if (!cloud) {
    const disconnect = bindGameHandlers(io, socket, register)
    socket.on("disconnect", (reason) => disconnect(reason))

    return
  }

  const rooms = new Set<string>()
  let pending = Promise.resolve()
  const enqueue = (action: () => Promise<void>) => {
    pending = pending.then(action).catch((error: unknown) => {
      console.error("Could not route room command:", error)
      socket.emit(EVENTS.GAME.ERROR_MESSAGE, "errors:api.serverError")
    })
  }
  bindGameHandlers(io, socket, (event) => {
    register(
      event,
      (...args: Parameters<ClientToServerEvents[typeof event]>) => {
        enqueue(async () => {
          const [message] = args
          const gameId =
            "ticket" in message
              ? (await checkJoinTicket(message.ticket, socket))?.gameId
              : message.gameId

          if (!gameId) {
            return
          }

          const reply = await routeCommand(
            io,
            { gameId, event, args, socketId: socket.id, data: socket.data },
            socket,
          )

          if (reply === "failed") {
            socket.emit(EVENTS.GAME.ERROR_MESSAGE, "errors:api.serverError")
          }

          if (reply === "missing") {
            if (event === EVENTS.MANAGER.RECONNECT) {
              socket.emit(EVENTS.GAME.RESET, "errors:game.expired")
            } else if (
              event === EVENTS.PLAYER.RECONNECT ||
              event === EVENTS.PLAYER.LOGIN
            ) {
              socket.emit(EVENTS.GAME.RESET, "errors:game.notFound")
            } else {
              socket.emit(EVENTS.GAME.ERROR_MESSAGE, "errors:game.notFound")
            }
          }

          if (typeof reply === "object" && "joined" in reply && reply.joined) {
            rooms.add(gameId)
          } else {
            rooms.delete(gameId)
          }
        })
      },
    )
  })
  socket.on("disconnect", (reason) =>
    enqueue(async () => {
      await Promise.all(
        [...rooms].map((gameId) =>
          routeCommand(io, {
            gameId,
            event: "disconnect",
            reason,
            socketId: socket.id,
            data: socket.data,
          }),
        ),
      )
    }),
  )
}
