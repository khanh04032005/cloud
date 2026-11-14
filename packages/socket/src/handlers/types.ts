import type { Server, Socket } from "@razzia/common/types/game/socket"

export type GameSocket = Pick<Socket, "id" | "data" | "join" | "to" | "emit">

export interface SocketContext {
  io: Server
  socket: Socket
}

export type SocketHandler = (_context: SocketContext) => void
