import { createDefaultGameSettings } from "@razzia/common/constants"
import type {
  GameSettings,
  Player,
  QuizzWithId,
} from "@razzia/common/types/game"
import { databaseUrl, redisUrl } from "@razzia/socket/env"
import type Game from "@razzia/socket/services/game"
import { randomUUID } from "node:crypto"
import {
  acquireLocked,
  releaseLease,
  roomKey,
  withLease,
  type RoomLease,
} from "@razzia/socket/services/leases"
import { metrics } from "@razzia/socket/services/metrics"
import { Pool, type PoolClient } from "pg"
import { createClient } from "redis"

export interface RoomAdmission {
  gameId: string
  hostClientId: string
  locked: boolean
  settings: GameSettings
  username: string | null
}

export class Cloud {
  readonly nodeId = randomUUID()
  readonly pool: Pool
  readonly redis: ReturnType<typeof createClient>
  readonly subscriber: ReturnType<typeof createClient>

  constructor(database: string, redis: string) {
    this.pool = new Pool({
      connectionString: database,
      connectionTimeoutMillis: 3000,
    })
    this.redis = createClient({ url: redis, disableOfflineQueue: true })
    this.subscriber = this.redis.duplicate()
    this.pool.on("error", (error) =>
      console.error("PostgreSQL connection:", error.message),
    )
    for (const client of [this.redis, this.subscriber]) {
      client.on("error", (error: Error) =>
        console.error("Redis connection:", error.message),
      )
    }
  }

  async connect() {
    await this.pool.query("SELECT owner_token, lease_until FROM rooms LIMIT 0")
    await Promise.all([this.redis.connect(), this.subscriber.connect()])
  }

  async ready() {
    if (!this.redis.isReady || !this.subscriber.isReady) {
      return false
    }

    try {
      await this.pool.query("SELECT 1")

      return true
    } catch {
      return false
    }
  }

  async close() {
    if (this.redis.isOpen) {
      this.redis.destroy()
    }

    if (this.subscriber.isOpen) {
      this.subscriber.destroy()
    }

    await this.pool.end()
  }

  async transaction<T>(run: (_client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()

    try {
      await client.query("BEGIN")
      const result = await run(client)
      await client.query("COMMIT")

      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async createRoom(game: Game, quiz: QuizzWithId): Promise<boolean> {
    const created = await this.transaction(async (client) => {
      const room = await client.query(
        `INSERT INTO rooms (id, invite_code, host_client_id, quiz_id, subject, settings, game_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invite_code) WHERE status IN ('lobby', 'running') DO NOTHING`,
        [
          game.gameId,
          game.inviteCode,
          game.manager.clientId,
          quiz.id,
          quiz.subject,
          game.settings,
          quiz.gameMode,
        ],
      )

      if (room.rowCount === 0) {
        return undefined
      }

      await client.query(
        `INSERT INTO rounds (room_id, question_id, position, question_snapshot)
         SELECT $1, q.id, entry.position, entry.definition
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS entry(definition, position)
         LEFT JOIN questions q ON q.quiz_id = $2 AND q.position = entry.position AND q.definition = entry.definition`,
        [game.gameId, quiz.id, JSON.stringify(quiz.questions)],
      )
      const lease = await acquireLocked(this, game.gameId, client)

      if (!lease) {
        throw new Error("Could not acquire newly created room")
      }

      return lease
    })

    if (!created) {
      return false
    }

    game.attachLease(created)
    metrics.increment("leases_acquired")

    return true
  }

  async findRoom(
    inviteCode: string,
    clientId?: string,
  ): Promise<RoomAdmission | undefined> {
    const { rows } = await this.pool.query<RoomAdmission>(
      `SELECT r.id AS "gameId", r.host_client_id AS "hostClientId", r.locked,
              r.settings, p.username
       FROM rooms AS r LEFT JOIN players AS p ON p.room_id = r.id AND p.id = $2 AND p.active
       WHERE r.invite_code = $1 AND r.status IN ('lobby', 'running')`,
      [inviteCode, clientId ?? null],
    )
    const room = rows.at(0)

    if (!room) {
      return undefined
    }

    return {
      ...room,
      settings: { ...createDefaultGameSettings(), ...room.settings },
    }
  }

  owner(gameId: string) {
    return this.redis.hGet(roomKey(gameId), "owner")
  }

  async saveLobby(game: Game) {
    await withLease(this, game.lease, (client) =>
      client.query(
        "UPDATE rooms SET settings = $2, locked = $3 WHERE id = $1",
        [game.gameId, game.settings, game.locked],
      ),
    )
  }

  async prunePlayers(game: Game) {
    await withLease(this, game.lease, (client) =>
      client.query(
        "UPDATE players SET active = false, connected = false WHERE room_id = $1 AND NOT (id = ANY($2::uuid[]))",
        [game.gameId, game.players.map(({ clientId }) => clientId)],
      ),
    )
  }

  async savePlayer(gameId: string, player: Player, lease?: RoomLease) {
    await withLease(this, lease, (client) =>
      client.query(
        `INSERT INTO players (room_id, id, username, socket_id, connected) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (room_id, id) DO UPDATE SET username = EXCLUDED.username, socket_id = EXCLUDED.socket_id, connected = true, active = true`,
        [gameId, player.clientId, player.username, player.id],
      ),
    )
  }

  async phase(
    gameId: string,
    state: {
      phase: "running" | "open" | "closed" | "finished"
      position?: number
      closesAt?: Date | null
    },
    lease?: RoomLease,
  ) {
    const { phase, position = 0, closesAt = null } = state
    const changed = await withLease(this, lease, (client) => {
      if (phase === "running" || phase === "finished") {
        return client.query(
          `UPDATE rooms SET status = $2, finished_at = CASE WHEN $2 = 'finished' THEN COALESCE(finished_at, now()) ELSE NULL END
           WHERE id = $1 AND (status IN ('lobby', 'running') OR (status = 'finished' AND $2 = 'finished'))`,
          [gameId, phase],
        )
      }

      return client.query(
        `UPDATE rounds SET status = $3, closes_at = COALESCE($4, closes_at),
           closed_at = CASE WHEN $3 = 'closed' THEN clock_timestamp() ELSE closed_at END
         WHERE room_id = $1 AND position = $2 AND status = $5
           AND EXISTS (SELECT 1 FROM rooms WHERE id = $1 AND status = 'running')`,
        [
          gameId,
          position,
          phase,
          closesAt,

          phase === "open" ? "pending" : "open",
        ],
      )
    })

    if (!changed.rowCount) {
      return false
    }

    if (phase === "closed") {
      metrics.increment("rounds_closed")
    }

    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('HSET', KEYS[2], 'phase', ARGV[2], 'position', ARGV[3])
       end return 0`,
      {
        keys: [`razzia:lease:${gameId}`, roomKey(gameId)],
        arguments: [lease?.token ?? "", phase, String(position)],
      },
    )

    return true
  }

  async removeRoom(gameId: string, lease?: RoomLease) {
    await withLease(this, lease, (client) =>
      client.query(
        `WITH cancelled AS (
         UPDATE rooms SET status = 'cancelled' WHERE id = $1 AND status IN ('lobby', 'running') RETURNING id
       ) UPDATE rounds SET status = 'closed', closed_at = COALESCE(closed_at, clock_timestamp())
         FROM cancelled WHERE room_id = cancelled.id AND status = 'open'`,
        [gameId],
      ),
    )

    if (lease) {
      await releaseLease(this, lease)
    }
  }
}

export const cloud =
  databaseUrl && redisUrl ? new Cloud(databaseUrl, redisUrl) : undefined
