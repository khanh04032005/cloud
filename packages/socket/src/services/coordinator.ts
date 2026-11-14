import type {
  Player,
  PlayerAnswerRecord,
  Question,
  QuestionResult,
} from "@razzia/common/types/game"
import type { Server } from "@razzia/common/types/game/socket"
import { STATUS } from "@razzia/common/types/game/status"
import { roomLeaseTtlMs } from "@razzia/socket/env"
import type { GameSocket } from "@razzia/socket/handlers/types"
import type { Cloud } from "@razzia/socket/services/cloud"
import Game from "@razzia/socket/services/game"
import type { RecoveredRoom } from "@razzia/socket/services/game/recovery-state"
import {
  acquireLease,
  releaseLease,
  renewLease,
  withLease,
  type RoomLease,
} from "@razzia/socket/services/leases"
import { metrics } from "@razzia/socket/services/metrics"
import Registry from "@razzia/socket/services/registry"

type StoredRoom = Omit<
  RecoveredRoom,
  | "quiz"
  | "lease"
  | "members"
  | "history"
  | "round_status"
  | "closes_at"
  | "answers"
>

export class RoomCoordinator {
  private readonly storage: Cloud
  private readonly io: Server
  private readonly loading = new Map<string, Promise<Game | undefined>>()
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private cycleTask: Promise<void> = Promise.resolve()

  constructor(storage: Cloud, io: Server) {
    this.storage = storage
    this.io = io
  }

  async start() {
    await this.cycle()
    this.schedule()
  }

  private schedule() {
    if (this.stopped) {
      return
    }

    this.timer = setTimeout(
      () => {
        this.cycleTask = this.cycle()
          .catch((error: unknown) =>
            console.error("Room coordination failed:", error),
          )
          .finally(() => this.schedule())
      },
      Math.min(1000, Math.floor(roomLeaseTtlMs / 3)),
    )
  }

  private async cycle() {
    const registry = Registry.getInstance()
    await Promise.all(
      registry.getAllGames().map(async (game) => {
        const { lease } = game

        if (!lease) {
          return
        }

        try {
          if (game.finished) {
            registry.releaseGame(game.gameId)
            await releaseLease(this.storage, lease)

            return
          }

          await renewLease(this.storage, lease)
        } catch (error) {
          metrics.increment("leases_lost")
          lease.invalidate()
          registry.releaseGame(game.gameId)
          await releaseLease(this.storage, lease).catch(
            (releaseError: unknown) =>
              console.error("Could not release lease:", releaseError),
          )
          console.error(`Coordinator stopped for room ${game.gameId}:`, error)
        }
      }),
    )

    if (this.stopped) {
      return
    }

    const { rows } = await this.storage.pool.query<{ id: string }>(
      "SELECT id FROM rooms WHERE status IN ('lobby', 'running') AND lease_until <= clock_timestamp() ORDER BY lease_until LIMIT 100",
    )
    await Promise.all(rows.map(({ id }) => this.ensure(id)))
    metrics.ownedRooms = registry
      .getAllGames()
      .filter((game) => game.ownsRoom).length
  }

  ensure(gameId: string): Promise<Game | undefined> {
    if (this.stopped) {
      return Promise.resolve(undefined)
    }

    const existing = this.loading.get(gameId)

    if (existing) {
      return existing
    }

    const current = Registry.getInstance().getGameById(gameId)

    if (current?.ownsRoom) {
      return Promise.resolve(current)
    }

    const task = this.recover(gameId).finally(() => this.loading.delete(gameId))
    this.loading.set(gameId, task)

    return task
  }

  private async recover(gameId: string) {
    const lease = await acquireLease(this.storage, gameId)

    if (!lease) {
      return undefined
    }

    try {
      const live = await this.io.in(gameId).fetchSockets()
      const snapshot = await this.load(
        lease,
        live.map((socket) => socket.id),
      )

      if (!snapshot) {
        await releaseLease(this.storage, lease)

        return undefined
      }

      const game = new Game(this.io, snapshot.host_client_id, snapshot)
      Registry.getInstance().releaseGame(gameId)
      Registry.getInstance().addGame(game)

      if (!snapshot.manager_connected) {
        Registry.getInstance().markGameAsEmpty(game)
      }

      game.resume(snapshot)
      const connections = await this.io.in(gameId).fetchSockets()
      await Promise.all(
        connections.map(async (connection) => {
          const socket: GameSocket = {
            id: connection.id,
            data: connection.data,
            join: (room) => this.io.in(connection.id).socketsJoin(room),
            to: (room) => this.io.to(room).except(connection.id),
            emit: (event, ...args) =>
              this.io.to(connection.id).emit(event, ...args),
          }

          return await game.reconnect(socket)
        }),
      )
      metrics.increment("rooms_recovered")

      return game
    } catch (error) {
      Registry.getInstance().releaseGame(gameId)
      await releaseLease(this.storage, lease).catch(console.error)
      throw error
    }
  }

  private load(lease: RoomLease, liveIds: string[]) {
    return withLease(
      this.storage,
      lease,
      async (client): Promise<RecoveredRoom | undefined> => {
        const { rows: rooms } = await client.query<
          StoredRoom & { game_mode: RecoveredRoom["quiz"]["gameMode"] }
        >("SELECT * FROM rooms WHERE id = $1", [lease.gameId])
        const room = rooms.at(0)

        if (!room || !["lobby", "running"].includes(room.status)) {
          return undefined
        }

        await client.query(
          "UPDATE players SET connected = socket_id = ANY($2::text[]) WHERE room_id = $1",
          [lease.gameId, liveIds],
        )
        await client.query(
          "UPDATE rooms SET manager_connected = manager_socket_id = ANY($2::text[]) WHERE id = $1",
          [lease.gameId, liveIds],
        )
        const { rows: rounds } = await client.query<{
          position: number
          status: string
          closes_at: Date | null
          question_snapshot: Question
        }>(
          "SELECT position, status, closes_at, question_snapshot FROM rounds WHERE room_id = $1 ORDER BY position",
          [lease.gameId],
        )
        const { rows: members } = await client.query<Player>(
          `SELECT COALESCE(NULLIF(p.socket_id, ''), 'offline:' || p.id::text) AS id, p.id AS "clientId", p.username, p.connected,
           COALESCE(r.points, 0) AS points, 0 AS streak,
           rank() OVER (ORDER BY COALESCE(r.points, 0) DESC)::integer AS rank
         FROM players p LEFT JOIN results r ON r.room_id = p.room_id AND r.player_id = p.id
         WHERE p.room_id = $1 AND p.active ORDER BY p.joined_at, p.id`,
          [lease.gameId],
        )
        const current = rounds.find(
          (round) => round.position === room.current_position,
        )
        const hostState =
          room.host_state_position === room.current_position
            ? room.host_state
            : null
        const shown =
          hostState?.name === STATUS.SHOW_RESPONSES ||
          hostState?.name === STATUS.SHOW_LEADERBOARD
        const { rows: history } = await client.query<{
          question_snapshot: Question
          player_answers: PlayerAnswerRecord[]
        }>(
          `SELECT r.question_snapshot, COALESCE((
           SELECT jsonb_agg(jsonb_build_object('playerName', p.username, 'answerIds', a.answer_keys) ||
             CASE WHEN $3 = 'survey' THEN '{}'::jsonb ELSE jsonb_build_object('correct', COALESCE(a.is_correct, false), 'points', CASE WHEN a.is_correct THEN 1 ELSE 0 END) END
             ORDER BY p.joined_at, p.id)
           FROM players p LEFT JOIN answers a ON a.round_id = r.id AND a.player_id = p.id WHERE p.room_id = r.room_id
         ), '[]') AS player_answers
         FROM rounds r WHERE r.room_id = $1 AND r.status = 'closed' AND r.position <= $2 ORDER BY r.position`,
          [
            lease.gameId,
            room.current_position - (shown ? 0 : 1),
            room.game_mode,
          ],
        )
        const { rows: answers } = await client.query<
          RecoveredRoom["answers"][number]
        >(
          `SELECT COALESCE(NULLIF(p.socket_id, ''), 'offline:' || p.id::text) AS "playerId", a.answer_keys AS "answerIds", 0 AS points
         FROM answers a JOIN players p ON p.room_id = a.room_id AND p.id = a.player_id
         JOIN rounds r ON r.id = a.round_id WHERE a.room_id = $1 AND r.position = $2`,
          [lease.gameId, room.current_position],
        )
        const questions: QuestionResult[] = history.map((entry) => ({
          ...entry.question_snapshot,
          ...(room.game_mode === "survey" && { solutions: undefined }),
          playerAnswers: entry.player_answers,
        }))

        return {
          ...room,
          lease,
          members,
          history: questions,
          answers,
          manager_connected: liveIds.includes(room.manager_socket_id),

          quiz: {
            subject: room.subject,
            gameMode: room.game_mode,
            questions: rounds.map((round) => round.question_snapshot),
          },
          round_status: current?.status ?? null,
          closes_at: current?.closes_at ?? null,
        }
      },
    )
  }

  async stop() {
    this.stopped = true

    if (this.timer) {
      clearTimeout(this.timer)
    }

    await this.cycleTask
    await Promise.all(this.loading.values())
    const registry = Registry.getInstance()
    const games = registry.getAllGames()
    registry.cleanup()
    await Promise.all(
      games.map((game) =>
        game.lease ? releaseLease(this.storage, game.lease) : Promise.resolve(),
      ),
    )
    metrics.ownedRooms = 0
  }
}

let coordinator: RoomCoordinator | undefined = undefined

export const setCoordinator = (value: RoomCoordinator) => {
  coordinator = value
}

export const ensureRoom = (gameId: string) =>
  coordinator?.ensure(gameId) ??
  Promise.resolve(Registry.getInstance().getGameById(gameId))
