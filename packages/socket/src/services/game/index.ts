import { createDefaultGameSettings, EVENTS } from "@razzia/common/constants"
import type {
  GameSettings,
  Player,
  Quizz,
  QuizzMode,
} from "@razzia/common/types/game"
import type { Server } from "@razzia/common/types/game/socket"
import {
  STATUS,
  type Status,
  type StatusDataMap,
} from "@razzia/common/types/game/status"
import type { GameSocket } from "@razzia/socket/handlers/types"
import { cloud } from "@razzia/socket/services/cloud"
import { CloudGame } from "@razzia/socket/services/cloud-game"
import { saveResult } from "@razzia/socket/services/config"
import { CooldownTimer } from "@razzia/socket/services/game/cooldown-timer"
import { PlayerManager } from "@razzia/socket/services/game/player-manager"
import { RoundManager } from "@razzia/socket/services/game/round-manager"
import type { RecoveredRoom } from "@razzia/socket/services/game/recovery-state"
import {
  LeaseLost,
  withLease,
  type RoomLease,
} from "@razzia/socket/services/leases"
import Registry from "@razzia/socket/services/registry"
import { createInviteCode } from "@razzia/socket/utils/game"
import { createNickname } from "@razzia/socket/utils/nickname"
import { SECOND_MS } from "@razzia/socket/utils/sleep"
import { getClientId } from "@razzia/socket/utils/socket"
import { v7 as uuid } from "uuid"

const registry = Registry.getInstance()

const MANAGER_GRACE_SECONDS = 30

class Game {
  readonly gameId: string
  readonly inviteCode: string
  readonly gameMode: QuizzMode

  private _settings: GameSettings = createDefaultGameSettings()
  private _locked = false

  private readonly io: Server
  private readonly _manager: {
    id: string
    clientId: string
    connected: boolean
  }
  private readonly playerManager: PlayerManager
  private readonly round: RoundManager
  private readonly cooldown: CooldownTimer
  private readonly persistence?: CloudGame
  private _lease?: RoomLease
  private managerGraceTimer: NodeJS.Timeout | null = null

  private lastBroadcastStatus: {
    name: Status
    data: StatusDataMap[Status]
  } | null = null
  private managerStatus: {
    name: Status
    data: StatusDataMap[Status]
  } | null = null
  private playerStatus = new Map<
    string,
    { name: Status; data: StatusDataMap[Status] }
  >()

  constructor(
    io: Server,
    managerClientId: string,
    input: Quizz | RecoveredRoom,
  ) {
    const recovered = "quiz" in input ? input : undefined
    const quizz = recovered ? recovered.quiz : (input as Quizz)
    this.io = io
    this.gameId = recovered?.id ?? uuid()
    this.inviteCode = recovered?.invite_code ?? createInviteCode()
    this.gameMode = quizz.gameMode
    this._manager = {
      id: recovered?.manager_socket_id ?? "",
      clientId: managerClientId,
      connected: recovered?.manager_connected ?? false,
    }

    this._lease = recovered?.lease
    this.cooldown = new CooldownTimer(io, this.gameId, () => this.ownsRoom)

    this.playerManager = new PlayerManager({
      io,
      gameId: this.gameId,
      gameMode: quizz.gameMode,
      getManagerId: () => this._manager.id,
      isStarted: () => this.started,
    })

    const storage = cloud
    this.persistence = storage && new CloudGame(storage, this.gameId)

    if (this._lease) {
      this.persistence?.attachLease(this._lease)
    }

    this.round = new RoundManager({
      quizz,
      players: this.playerManager,
      cooldown: this.cooldown,
      io,
      gameId: this.gameId,
      getManagerId: () => this._manager.id,
      broadcast: this.broadcastStatus.bind(this),
      send: this.sendStatus.bind(this),
      onNewQuestion: () => {
        this.playerStatus.clear()
        this.managerStatus = null
      },
      onGameFinished: (result) =>
        this.persistence
          ? this.persistence.saveReport(result)
          : saveResult(result),
      persistence: this.persistence,
      savePhase:
        storage &&
        (async (phase, position, closesAt) => {
          if (phase === "running") {
            await storage.prunePlayers(this)
          }

          await storage.phase(
            this.gameId,
            { phase, position, closesAt },
            this.lease,
          )
        }),
      onFailure: (error) => this.fail(error),
      getSettings: () => this._settings,
      canRun: () => this.ownsRoom,
    })

    if (recovered) {
      this._settings = recovered.settings
      this._locked = recovered.locked
      this.lastBroadcastStatus = recovered.runtime
      this.managerStatus =
        recovered.host_state_position === recovered.current_position
          ? recovered.host_state
          : null
      this.playerManager.replace(recovered.members)
    }

    console.log(
      `New game created: ${this.inviteCode} subject: ${quizz.subject}`,
    )
  }

  get manager() {
    return this._manager
  }

  get lease() {
    return this._lease
  }

  get ownsRoom() {
    return !cloud || Boolean(this._lease?.active)
  }

  attachLease(lease: RoomLease) {
    if (this._lease && this._lease.token !== lease.token) {
      throw new LeaseLost(this.gameId)
    }

    this._lease = lease
    this.persistence?.attachLease(lease)
  }

  async assertOwner() {
    if (cloud) {
      await withLease(cloud, this.lease, () => Promise.resolve())
    }
  }

  resume(recovered: RecoveredRoom) {
    this.round.restore(recovered)
  }

  get players(): Player[] {
    return this.playerManager.getAll()
  }

  get finished(): boolean {
    return this.round.completed
  }

  get started(): boolean {
    return this.round.isStarted()
  }

  get settings(): GameSettings {
    return this._settings
  }

  updateSettings(settings: Partial<GameSettings>): boolean {
    if (this.started) {
      return false
    }

    this._settings = { ...this._settings, ...settings }

    return true
  }

  get locked(): boolean {
    return this._locked
  }

  setLocked(locked: boolean) {
    const previous = this._locked
    this._locked = locked
    const notify = () => {
      if (this.ownsRoom) {
        this.io.to(this._manager.id).emit(EVENTS.MANAGER.LOCK_UPDATED, locked)
      }
    }

    if (!cloud) {
      return notify()
    }

    return cloud.saveLobby(this).then(notify, (error: unknown) => {
      this._locked = previous
      throw error
    })
  }

  // ── Status broadcasting ──────────────────────────────────────────────────

  private broadcastStatus<T extends Status>(
    status: T,
    data: StatusDataMap[T],
    deadline: Date | null = null,
  ) {
    const statusData = { name: status, data }
    this.lastBroadcastStatus = statusData
    const emit = () => {
      if (this.ownsRoom) {
        this.io.to(this.gameId).emit(EVENTS.GAME.STATUS, statusData)
      }
    }

    if (this.persistence) {
      return this.persistence
        .broadcast(statusData, this.round.position, deadline)
        .then(emit)
    }

    emit()
  }

  private sendStatus<T extends Status>(
    target: string,
    status: T,
    data: StatusDataMap[T],
  ) {
    const statusData = { name: status, data }

    if (this._manager.id === target) {
      this.managerStatus = statusData
    } else {
      this.playerStatus.set(target, statusData)
    }

    const emit = () => {
      if (this.ownsRoom) {
        this.io.to(target).emit(EVENTS.GAME.STATUS, statusData)
      }
    }
    const player = this.playerManager.findById(target)

    if (this.persistence && target === this._manager.id) {
      let delay: number | null = null

      if (status === STATUS.SHOW_RESPONSES) {
        delay = this.settings.autoAdvance.responsesDelay
      }

      if (status === STATUS.SHOW_LEADERBOARD) {
        delay = this.settings.autoAdvance.leaderboardDelay
      }

      const deadline =
        this.settings.autoAdvance.enable && delay !== null
          ? new Date(Date.now() + delay * SECOND_MS)
          : null

      return this.persistence
        .managerState(statusData, this.round.position, deadline)
        .then(emit)
    }

    if (this.persistence && player) {
      return this.persistence
        .playerState(player.clientId, statusData, this.round.position)
        .then(emit)
    }

    emit()
  }

  // Player actions

  join(socket: GameSocket, username?: string) {
    if (this._locked) {
      return "errors:game.locked"
    }

    const storage = cloud
    const persist =
      storage &&
      ((player: Player) => storage.savePlayer(this.gameId, player, this.lease))

    if (this._settings.generatedUsernames) {
      const taken = this.playerManager.getAll().map((player) => player.username)

      return this.playerManager.join(socket, createNickname(taken), persist)
    }

    if (!username) {
      return "errors:auth.usernameTooShort"
    }

    return this.playerManager.join(socket, username, persist)
  }

  dispose() {
    this.round.stop()
    this.round.clearAutoAdvance()
    this.cooldown.abort()
    this.cancelManagerGrace()
  }

  private fail(error: unknown) {
    if (error instanceof LeaseLost) {
      registry.releaseGame(this.gameId)

      return
    }

    console.error(`Room ${this.gameId} failed:`, error)
    this.io.to(this.gameId).emit(EVENTS.GAME.RESET, "errors:api.serverError")
    registry.removeGame(this.gameId)
  }

  waitForManager(onTimeout: () => void) {
    this.cancelManagerGrace()
    this.managerGraceTimer = setTimeout(() => {
      this.managerGraceTimer = null

      if (!this._manager.connected && !this.started) {
        onTimeout()
      }
    }, MANAGER_GRACE_SECONDS * SECOND_MS)
  }

  private cancelManagerGrace() {
    if (this.managerGraceTimer) {
      clearTimeout(this.managerGraceTimer)
      this.managerGraceTimer = null
    }
  }

  kickPlayer(playerId: string) {
    if (this.playerManager.kick(playerId)) {
      this.playerStatus.delete(playerId)
    }
  }

  // Reconnect

  reconnect(socket: GameSocket) {
    const clientId = getClientId(socket)

    if (this._manager.clientId === clientId) {
      this.reconnectManager(socket)

      return
    }

    return this.reconnectPlayer(socket)
  }

  private reconnectManager(socket: GameSocket) {
    if (this.persistence) {
      return this.persistence
        .managerConnection(socket.id, true)
        .then(() => this.applyManagerReconnect(socket))
    }

    return this.applyManagerReconnect(socket)
  }

  private applyManagerReconnect(socket: GameSocket) {
    const previousSocketId = this._manager.connected ? this._manager.id : null

    socket.join(this.gameId)
    this._manager.id = socket.id
    this._manager.connected = true
    this.cancelManagerGrace()

    if (previousSocketId && previousSocketId !== socket.id) {
      this.io
        .to(previousSocketId)
        .emit(EVENTS.GAME.RESET, "errors:game.managerAlreadyConnected")
      this.io.in(previousSocketId).disconnectSockets(true)
    }

    const status = (() => {
      if (this.managerStatus) {
        return this.managerStatus
      }

      if (this.lastBroadcastStatus) {
        return this.lastBroadcastStatus
      }

      return {
        name: STATUS.SHOW_ROOM,
        data: {
          text: "game:waitingForPlayers",
          inviteCode: this.inviteCode,
        },
      }
    })()

    socket.emit(EVENTS.MANAGER.SUCCESS_RECONNECT, {
      gameId: this.gameId,
      inviteCode: this.inviteCode,
      settings: this._settings,
      locked: this._locked,
      currentQuestion: this.round.getReconnectInfo(),
      status,
      players: this.playerManager.getAll(),
    })
    socket.emit(EVENTS.GAME.TOTAL_PLAYERS, this.playerManager.joinedCount())

    registry.reactivateGame(this.gameId)
    console.log(`Manager reconnected to game ${this.inviteCode}`)
  }

  private reconnectPlayer(socket: GameSocket) {
    if (this.persistence) {
      return this.reconnectCloudPlayer(socket, this.persistence)
    }

    const clientId = getClientId(socket)
    const player = this.playerManager.findByClientId(clientId)

    if (!player) {
      return
    }

    socket.join(this.gameId)

    const oldSocketId = player.id
    const replacesConnection = player.connected && oldSocketId !== socket.id
    this.playerManager.updateSocketId(oldSocketId, socket.id)
    this.round.updatePlayerId(oldSocketId, socket.id)
    player.connected = true
    this.notifyPlayerUpdated(oldSocketId, player)

    if (replacesConnection) {
      this.io.in(oldSocketId).disconnectSockets(true)
    }

    const status = this.playerStatus.get(oldSocketId) ??
      this.lastBroadcastStatus ?? {
        name: STATUS.WAIT,
        data: { text: "game:waitingForPlayers" },
      }

    const oldStatus = this.playerStatus.get(oldSocketId)

    if (oldStatus) {
      this.playerStatus.delete(oldSocketId)
      this.playerStatus.set(socket.id, oldStatus)
    }

    socket.emit(EVENTS.PLAYER.SUCCESS_RECONNECT, {
      gameId: this.gameId,
      gameMode: this.gameMode,
      currentQuestion: this.round.getReconnectInfo(),
      status,
      player: { username: player.username, points: player.points },
    })
    this.playerManager.broadcastCount()

    console.log(
      `Player ${player.username} reconnected to game ${this.inviteCode}`,
    )
  }

  private async reconnectCloudPlayer(
    socket: GameSocket,
    persistence: CloudGame,
  ) {
    const restored = await persistence.reconnect(socket)

    if (!restored) {
      socket.emit(EVENTS.GAME.RESET, "errors:game.notFound")

      return
    }

    const { player, payload } = restored
    const existing = this.playerManager.findByClientId(player.clientId)
    const oldId = existing?.id ?? player.id
    const previousStatus = this.playerStatus.get(oldId)
    this.playerStatus.delete(oldId)

    if (previousStatus) {
      this.playerStatus.set(socket.id, previousStatus)
    }

    const replacement = { ...player, id: socket.id, connected: true }
    this.playerManager.replace([
      ...this.players.filter((entry) => entry.clientId !== player.clientId),
      replacement,
    ])
    this.round.updatePlayerId(oldId, socket.id)
    await socket.join(this.gameId)

    if (oldId && oldId !== socket.id) {
      this.io.in(oldId).disconnectSockets(true)
    }

    socket.emit(EVENTS.PLAYER.SUCCESS_RECONNECT, payload)
    this.notifyPlayerUpdated(oldId, replacement)
    this.playerManager.broadcastCount()
  }

  // Disconnect helpers

  setManagerDisconnected() {
    this._manager.connected = false

    return this.persistence?.managerConnection(this._manager.id, false)
  }

  removePlayer(socketId: string): Player | undefined {
    const player = this.playerManager.remove(socketId)

    if (player) {
      this.io.to(this._manager.id).emit(EVENTS.MANAGER.REMOVE_PLAYER, player.id)
      this.playerManager.broadcastCount()
    }

    return player
  }

  setPlayerDisconnected(socketId: string, timedOut = false) {
    this.playerManager.setDisconnected(socketId)
    this.playerManager.broadcastCount()
    this.round.endIfEveryoneAnswered()

    const player = this.playerManager.findById(socketId)

    if (player) {
      this.notifyPlayerUpdated(socketId, player, timedOut)
    }

    return this.persistence?.disconnect(socketId)
  }

  private notifyPlayerUpdated(
    previousId: string,
    player: Player,
    timedOut = false,
  ) {
    this.io
      .to(this._manager.id)
      .emit(EVENTS.MANAGER.PLAYER_UPDATED, { previousId, player, timedOut })
  }

  // Game flow

  abortCooldown() {
    this.cooldown.abort()
  }

  async start(socket: GameSocket) {
    if (!this.started) {
      const away = this.playerManager.getAll().filter((p) => !p.connected)

      for (const player of away) {
        this.removePlayer(player.id)
      }
    }

    try {
      await this.round.start(socket)
    } catch (error) {
      this.fail(error)
    }
  }

  selectAnswer(socket: GameSocket, answerIds: number[], roundId?: string) {
    return this.round.selectAnswer(socket, answerIds, roundId)
  }

  advance() {
    this.round.advance()
  }
}

export default Game
