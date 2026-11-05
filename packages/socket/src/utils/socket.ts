import type { GameSocket } from "@razzia/socket/handlers/types"

export const getClientId = (socket: GameSocket): string => socket.data.clientId
