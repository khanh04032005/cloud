export function csvCell(value) {
  if (value === null || value === undefined) {
    return ""
  }

  const text = String(value)

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }

  return text
}

export function toCsv(headers, rows) {
  const lines = [headers.join(",")]

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","))
  }

  return `${lines.join("\n")}\n`
}

/** Competition rank: equal scores share the earlier rank (1, 2, 2, 4). */
export function assignRanks(rows) {
  const ordered = [...rows].sort((a, b) => {
    if (b.points !== a.points) {
      return b.points - a.points
    }

    return String(a.player_id).localeCompare(String(b.player_id))
  })

  let previous = null
  let rank = 0

  return ordered.map((row, index) => {
    if (row.points !== previous) {
      rank = index + 1
      previous = row.points
    }

    return { ...row, rank }
  })
}

export const RESULTS_HEADERS = [
  "room_id",
  "player_id",
  "display_name",
  "points",
  "correct_answers",
  "accepted_answers",
  "rank",
]

export const ANSWER_HEADERS = [
  "room_id",
  "round_id",
  "player_id",
  "choice",
  "is_correct",
  "accepted_at",
  "event_id",
]

export function resultsSql(roomId) {
  const values = []
  const filter = roomId ? "WHERE ps.room_id = $1" : ""

  if (roomId) {
    values.push(roomId)
  }

  return {
    text: `SELECT
        ps.room_id,
        ps.player_id,
        COALESCE(pl.display_name, ps.player_id) AS display_name,
        ps.points,
        COALESCE(counts.correct_count, 0)::int AS correct_answers,
        COALESCE(counts.accepted_count, 0)::int AS accepted_answers
      FROM player_scores AS ps
      LEFT JOIN players AS pl
        ON pl.room_id = ps.room_id AND pl.id = ps.player_id
      LEFT JOIN (
        SELECT
          r.room_id,
          a.player_id,
          COUNT(*)::int AS accepted_count,
          COUNT(*) FILTER (WHERE a.is_correct)::int AS correct_count
        FROM answers AS a
        JOIN rounds AS r ON r.id = a.round_id
        GROUP BY r.room_id, a.player_id
      ) AS counts
        ON counts.room_id = ps.room_id AND counts.player_id = ps.player_id
      ${filter}
      ORDER BY ps.room_id, ps.points DESC, ps.player_id`,
    values,
  }
}

export function answersSql(roomId) {
  const values = []
  const filter = roomId ? "WHERE r.room_id = $1" : ""

  if (roomId) {
    values.push(roomId)
  }

  return {
    text: `SELECT
        r.room_id,
        a.round_id,
        a.player_id,
        a.choice,
        a.is_correct,
        a.accepted_at,
        a.event_id
      FROM answers AS a
      JOIN rounds AS r ON r.id = a.round_id
      ${filter}
      ORDER BY r.room_id, a.accepted_at, a.player_id`,
    values,
  }
}

export function exportKeys(roomId, now = new Date()) {
  const stamp = now.toISOString().replaceAll(":", "-")
  const folder = roomId ? roomId : "all"

  return {
    results: `exports/${folder}/results-${stamp}.csv`,
    answers: `exports/${folder}/answers-${stamp}.csv`,
  }
}

export function shapeAnswerRow(row) {
  return {
    ...row,
    choice: typeof row.choice === "string" ? row.choice : JSON.stringify(row.choice),
    is_correct: row.is_correct ? "true" : "false",
    accepted_at:
      row.accepted_at instanceof Date
        ? row.accepted_at.toISOString()
        : row.accepted_at,
  }
}
