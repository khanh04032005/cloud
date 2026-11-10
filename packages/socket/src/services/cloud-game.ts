import { EVENTS, QUESTION_TYPES, QUIZZ_MODES } from "@razzia/common/constants"
import { isEstimationOptions } from "@razzia/common/questions/options"
import type {
  GameResult,
  Player,
  Question,
  QuizzMode,
} from "@razzia/common/types/game"
import type { ServerToClientEvents } from "@razzia/common/types/game/socket"
import {
  STATUS,
  type Status,
  type StatusDataMap,
} from "@razzia/common/types/game/status"
import type { GameSocket } from "@razzia/socket/handlers/types"
import type { Cloud } from "@razzia/socket/services/cloud"
import { QUESTION_SCORING } from "@razzia/socket/services/scoring"
import type { ScoredPlayer } from "@razzia/socket/services/scoring/round"
import { SECOND_MS } from "@razzia/socket/utils/sleep"
import { setTimeout as delay } from "node:timers/promises"
import type { PoolClient } from "pg"

interface GameState {
  name: Status
  data: StatusDataMap[Status]
}
type Receipt = Parameters<
  ServerToClientEvents[typeof EVENTS.PLAYER.ANSWER_ACK]
>[0]
type Reconnect = Parameters<
  ServerToClientEvents[typeof EVENTS.PLAYER.SUCCESS_RECONNECT]
>[0]

interface StoredAnswer {
  round_id: string
  answer_keys: number[]
  is_correct: boolean
  accepted_at: Date
}

interface Member extends Player {
  active: boolean
  state: GameState | null
  state_position: number
}

interface RoomState {
  runtime: GameState | null
  current_position: number
  status: string
  total: number
  game_mode: QuizzMode
}

const normalize = (
  question: Question,
  keys: number[],
): number[] | undefined => {
  if (isEstimationOptions(question.options)) {
    const [value] = keys

    if (keys.length !== 1 || !Number.isFinite(value)) {
      return undefined
    }

    return [
      Math.min(question.options.max, Math.max(question.options.min, value)),
    ]
  }

  if (question.type === QUESTION_TYPES.SINGLE && keys.length !== 1) {
    return undefined
  }

  if (
    keys.some(
      (key) =>
        !Number.isInteger(key) || key < 0 || key >= question.answers.length,
    )
  ) {
    return undefined
  }

  if (new Set(keys).size !== keys.length) {
    return undefined
  }

  return keys
}

export class CloudGame {
  private writes = Promise.resolve()
  readonly storage: Cloud
  readonly gameId: string

  constructor(storage: Cloud, gameId: string) {
    this.storage = storage
    this.gameId = gameId
  }

  private write(run: () => Promise<void>) {
    const next = this.writes.then(run)
    this.writes = next.catch(() => undefined)

    return next
  }

  broadcast(state: GameState, position: number) {
    return this.write(async () => {
      await this.storage.pool.query(
        "UPDATE rooms SET runtime = $2, current_position = $3 WHERE id = $1",
        [this.gameId, state, position],
      )
    })
  }

  playerState(clientId: string, state: GameState, position: number) {
    return this.write(async () => {
      await this.storage.pool.query(
        "UPDATE players SET state = $3, state_position = $4 WHERE room_id = $1 AND id = $2",
        [this.gameId, clientId, state, position],
      )
    })
  }

  async roundId(position: number) {
    const { rows } = await this.storage.pool.query<{ id: string }>(
      "SELECT id FROM rounds WHERE room_id = $1 AND position = $2",
      [this.gameId, position],
    )

    return rows.at(0)?.id
  }

  accept(submission: {
    playerId: string
    socketId: string
    position: number
    roundId?: string
    keys: number[]
  }): Promise<Receipt> {
    return this.storage.transaction(async (client) => {
      const { rows: rooms } = await client.query<{
        status: string
        current_position: number
        game_mode: QuizzMode
      }>(
        `SELECT status, current_position, game_mode
         FROM rooms WHERE id = $1 FOR SHARE`,
        [this.gameId],
      )
      const room = rooms.at(0)
      const { rows: rounds } = await client.query<{
        id: string
        status: string
        closes_at: Date | null
        question_snapshot: Question
      }>(
        `SELECT id, status, closes_at, question_snapshot FROM rounds
         WHERE room_id = $1 AND ${submission.roundId ? "id = $2::uuid" : "position = $2::integer"} FOR SHARE`,
        [this.gameId, submission.roundId ?? submission.position],
      )
      const round = rounds.at(0)
      const { rows: members } = await client.query<{
        active: boolean
        socket_id: string
      }>(
        "SELECT active, socket_id FROM players WHERE room_id = $1 AND id = $2 FOR SHARE",
        [this.gameId, submission.playerId],
      )

      if (
        !room ||
        !members.at(0)?.active ||
        members.at(0)?.socket_id !== submission.socketId
      ) {
        return { status: "forbidden" }
      }

      if (!round) {
        return { status: "closed" }
      }

      const previous = await CloudGame.answer(
        client,
        round.id,
        submission.playerId,
      )

      if (previous) {
        return CloudGame.receipt(previous, "duplicate")
      }

      const {
        rows: [clock],
      } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")

      if (
        room.status !== "running" ||
        round.status !== "open" ||
        (round.closes_at && clock.now >= round.closes_at)
      ) {
        return { status: "closed", roundId: round.id }
      }

      const keys = normalize(round.question_snapshot, submission.keys)

      if (!keys) {
        return { status: "invalid", roundId: round.id }
      }

      const correct =
        room.game_mode !== QUIZZ_MODES.SURVEY &&
        QUESTION_SCORING[round.question_snapshot.type](
          round.question_snapshot,
          keys,
        ) > 0
      const choice =
        keys.length === 1 && Number.isInteger(keys[0]) && keys[0] >= 0
          ? keys[0]
          : null
      const inserted = await client.query<StoredAnswer>(
        `INSERT INTO answers (room_id, round_id, player_id, choice, answer_keys, is_correct, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (round_id, player_id) DO NOTHING RETURNING *`,
        [
          this.gameId,
          round.id,
          submission.playerId,
          choice,
          JSON.stringify(keys),
          correct,
          clock.now,
        ],
      )
      const answer = inserted.rows.at(0)

      if (!answer) {
        const existing = await CloudGame.answer(
          client,
          round.id,
          submission.playerId,
        )

        if (!existing) {
          throw new Error("Conflicting answer was not found")
        }

        return CloudGame.receipt(existing, "duplicate")
      }

      await client.query(
        "INSERT INTO outbox (round_id, player_id) VALUES ($1, $2)",
        [round.id, submission.playerId],
      )

      return CloudGame.receipt(answer, "accepted")
    })
  }

  private static async answer(
    client: PoolClient,
    roundId: string,
    playerId: string,
  ) {
    const { rows } = await client.query<StoredAnswer>(
      "SELECT * FROM answers WHERE round_id = $1 AND player_id = $2",
      [roundId, playerId],
    )

    return rows.at(0)
  }

  private static receipt(
    answer: StoredAnswer,
    status: "accepted" | "duplicate",
  ): Receipt {
    return {
      status,
      roundId: answer.round_id,
      answerKeys: answer.answer_keys,
      acceptedAt: answer.accepted_at.toISOString(),
    }
  }

  async waitForScores(position: number | null, running: () => boolean) {
    // oxlint-disable no-await-in-loop -- Poll serially while waiting for B, allowing game shutdown between reads.
    while (running()) {
      const {
        rows: [pending],
      } = await this.storage.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM outbox o JOIN answers a USING (round_id, player_id)
         JOIN rounds r ON r.id = a.round_id LEFT JOIN processed_answer_events p ON p.event_id = o.event_id
         WHERE a.room_id = $1 AND ($2::integer IS NULL OR r.position = $2) AND p.event_id IS NULL`,
        [this.gameId, position],
      )

      if (pending.count === 0) {
        return true
      }

      await delay(100)
    }

    return false
    // oxlint-enable no-await-in-loop
  }

  async scores(position: number) {
    const { rows } = await this.storage.pool.query<
      ScoredPlayer & { active: boolean; answer_keys: number[] | null }
    >(
      `SELECT p.socket_id AS id, p.id AS "clientId", p.username, p.connected, p.active,
         COALESCE(s.points, 0) AS points, 0 AS streak,
         rank() OVER (ORDER BY COALESCE(s.points, 0) DESC)::integer AS rank,
         COALESCE(a.is_correct, false) AS "lastCorrect",
         CASE WHEN a.is_correct THEN 1 ELSE 0 END AS "lastPoints", a.answer_keys
       FROM players p LEFT JOIN results s ON s.room_id = p.room_id AND s.player_id = p.id
       LEFT JOIN rounds r ON r.room_id = p.room_id AND r.position = $2
       LEFT JOIN answers a ON a.round_id = r.id AND a.player_id = p.id
       WHERE p.room_id = $1 ORDER BY points DESC, p.joined_at, p.id`,
      [this.gameId, position],
    )

    return rows
  }

  reconnect(
    socket: GameSocket,
  ): Promise<{ payload: Reconnect; player: Member } | undefined> {
    return this.storage.transaction(async (client) => {
      const { rows: rooms } = await client.query<RoomState>(
        `SELECT status, runtime, current_position,
           (SELECT count(*)::integer FROM rounds WHERE room_id = rooms.id) AS total,
           game_mode
         FROM rooms WHERE id = $1 FOR SHARE`,
        [this.gameId],
      )
      const room = rooms.at(0)
      const { rows: members } = await client.query<Member>(
        `SELECT socket_id AS id, id AS "clientId", username, connected, active, state, state_position,
           0 AS points, 0 AS streak FROM players WHERE room_id = $1 AND id = $2 FOR UPDATE`,
        [this.gameId, socket.data.clientId],
      )
      const member = members.at(0)

      if (!room || room.status === "cancelled" || !member?.active) {
        return undefined
      }

      const { rows: points } = await client.query<{ points: number }>(
        "SELECT points FROM results WHERE room_id = $1 AND player_id = $2",
        [this.gameId, member.clientId],
      )
      member.points = points.at(0)?.points ?? 0
      const { rows: rounds } = await client.query<{
        id: string
        status: string
        closes_at: Date | null
      }>(
        "SELECT id, status, closes_at FROM rounds WHERE room_id = $1 AND position = $2",
        [this.gameId, room.current_position],
      )
      const round = rounds.at(0)
      const answer = round
        ? await CloudGame.answer(client, round.id, member.clientId)
        : undefined
      let state: GameState = room.runtime ?? {
        name: STATUS.WAIT,
        data: { text: "game:waitingForPlayers" },
      }

      const { state: storedState } = member

      if (
        member.state_position === room.current_position &&
        storedState &&
        new Set<Status>([
          STATUS.SHOW_RESULT,
          STATUS.FINISHED,
          STATUS.SUMMARY,
        ]).has(storedState.name)
      ) {
        state = storedState
      } else if (
        state.name === STATUS.SELECT_ANSWER &&
        (answer || round?.status !== "open")
      ) {
        state = { name: STATUS.WAIT, data: { text: "game:waitingForAnswers" } }
      } else if (state.name === STATUS.SELECT_ANSWER && round?.closes_at) {
        state = {
          ...state,
          data: {
            ...state.data,
            time: Math.max(
              0,
              Math.ceil((round.closes_at.getTime() - Date.now()) / SECOND_MS),
            ),
          },
        }
      }

      await client.query(
        "UPDATE players SET socket_id = $3, connected = true WHERE room_id = $1 AND id = $2",
        [this.gameId, member.clientId, socket.id],
      )

      return {
        player: member,
        payload: {
          gameId: this.gameId,
          gameMode: room.game_mode,
          status: state,
          player: { username: member.username, points: member.points },
          currentQuestion:
            room.current_position > 0
              ? { current: room.current_position, total: room.total }
              : null,
          acceptedAnswer: answer
            ? {
                answerKeys: answer.answer_keys,
                acceptedAt: answer.accepted_at.toISOString(),
              }
            : null,
        },
      }
    })
  }

  async disconnect(socketId: string) {
    await this.storage.pool.query(
      "UPDATE players SET connected = false WHERE room_id = $1 AND socket_id = $2",
      [this.gameId, socketId],
    )
  }

  async saveReport(report: GameResult) {
    await this.storage.transaction(async (client) => {
      const { rows: inconsistent } = await client.query<{ id: string }>(
        `SELECT p.id FROM players p LEFT JOIN results r ON r.room_id = p.room_id AND r.player_id = p.id
         LEFT JOIN answers a ON a.room_id = p.room_id AND a.player_id = p.id WHERE p.room_id = $1
         GROUP BY p.id, r.points HAVING COALESCE(r.points, 0) <> count(*) FILTER (WHERE a.is_correct)`,
        [this.gameId],
      )

      if (inconsistent.length) {
        throw new Error("Worker scores do not match accepted answers")
      }

      await client.query(
        "INSERT INTO game_reports (id, room_id, report) VALUES ($1, $2, $3) ON CONFLICT (room_id) DO NOTHING",
        [report.id, this.gameId, report],
      )
      await client.query(
        "UPDATE rooms SET status = 'finished', finished_at = now() WHERE id = $1 AND status = 'running'",
        [this.gameId],
      )
    })
  }
}
