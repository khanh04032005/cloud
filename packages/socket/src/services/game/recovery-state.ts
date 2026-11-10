import type {
  GameSettings,
  Player,
  QuestionResult,
  Quizz,
} from "@razzia/common/types/game"
import type { GameState } from "@razzia/socket/services/cloud-game"
import type { RoomLease } from "@razzia/socket/services/leases"

export interface RecoveredRoom {
  id: string
  invite_code: string
  host_client_id: string
  subject: string
  settings: GameSettings
  locked: boolean
  status: string
  current_position: number
  runtime: GameState | null
  host_state: GameState | null
  host_state_position: number
  stage_deadline: Date | null
  auto_advance_at: Date | null
  manager_socket_id: string
  manager_connected: boolean
  quiz: Quizz
  lease: RoomLease
  members: Player[]
  history: QuestionResult[]
  round_status: string | null
  closes_at: Date | null
  answers: Array<{ playerId: string; answerIds: number[]; points: number }>
}
