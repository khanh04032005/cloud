import type { GameResult, GameResultMeta } from "@razzia/common/types/game"
import { cloud } from "@razzia/socket/services/cloud"
import * as files from "@razzia/socket/services/config"

export const getResultsMeta = async (): Promise<GameResultMeta[]> => {
  const legacy = files.getResultsMeta()

  if (!cloud) {
    return legacy
  }

  const { rows } = await cloud.pool.query<{ report: GameResult }>(
    "SELECT report FROM game_reports",
  )
  const stored = rows.map(({ report }) => ({
    id: report.id,
    subject: report.subject,
    date: report.date,
    gameMode: report.gameMode,
    playerCount: report.players.length,
  }))

  return [
    ...new Map(
      [...legacy, ...stored].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}

export const getResultById = async (id: string): Promise<GameResult> => {
  if (cloud) {
    const { rows } = await cloud.pool.query<{ report: GameResult }>(
      "SELECT report FROM game_reports WHERE id = $1",
      [id],
    )
    const result = rows.at(0)

    if (result) {
      return result.report
    }
  }

  return files.getResultById(id)
}

export const deleteResult = async (id: string) => {
  if (cloud) {
    const deleted = await cloud.pool.query(
      "DELETE FROM game_reports WHERE id = $1",
      [id],
    )

    if (deleted.rowCount) {
      return
    }
  }

  files.deleteResult(id)
}
