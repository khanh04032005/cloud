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
    const roomOrder = String(a.room_id ?? "").localeCompare(
      String(b.room_id ?? ""),
    )
    if (roomOrder !== 0) {
      return roomOrder
    }
    if (b.points !== a.points) {
      return b.points - a.points
    }

    return String(a.player_id).localeCompare(String(b.player_id))
  })

  let previous = null
  let previousRoom
  let roomStart = 0
  let rank = 0

  return ordered.map((row, index) => {
    if (index === 0 || row.room_id !== previousRoom) {
      previous = null
      roomStart = index
      previousRoom = row.room_id
    }
    if (row.points !== previous) {
      rank = index - roomStart + 1
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
  "answer_keys",
  "is_correct",
  "accepted_at",
  "event_id",
]

export function resultsSql(roomId) {
  const values = []
  const filter = roomId ? "WHERE p.room_id = $1" : ""

  if (roomId) {
    values.push(roomId)
  }

  return {
    text: `SELECT
        p.room_id,
        p.id AS player_id,
        p.username AS display_name,
        audit.stored_points AS points,
        audit.expected_points AS correct_answers,
        audit.accepted_answers,
        audit.point_delta,
        audit.missing_result,
        audit.missing_outbox,
        audit.pending_score_events
      FROM players p
      JOIN score_audit audit ON audit.room_id = p.room_id AND audit.player_id = p.id
      ${filter}
      ORDER BY p.room_id, points DESC, p.id`,
    values,
  }
}

export function answersSql(roomId) {
  const values = []
  const filter = roomId ? "WHERE a.room_id = $1" : ""

  if (roomId) {
    values.push(roomId)
  }

  return {
    text: `SELECT
        a.room_id,
        a.round_id,
        a.player_id,
        a.choice,
        a.answer_keys,
        a.is_correct,
        a.accepted_at,
        o.event_id
      FROM answers AS a
      LEFT JOIN outbox AS o USING (round_id, player_id)
      ${filter}
      ORDER BY a.room_id, a.accepted_at, a.player_id`,
    values,
  }
}

export function exportKeys(roomId, now = new Date()) {
  const stamp = now.toISOString().replaceAll(":", "-")
  const folder = roomId ?? "all"

  return {
    results: `exports/${folder}/results-${stamp}.csv`,
    answers: `exports/${folder}/answers-${stamp}.csv`,
  }
}

export function shapeAnswerRow(row) {
  return {
    ...row,
    choice:
      typeof row.choice === "string" ? row.choice : JSON.stringify(row.choice),
    answer_keys: JSON.stringify(row.answer_keys),
    is_correct: row.is_correct ? "true" : "false",
    accepted_at:
      row.accepted_at instanceof Date
        ? row.accepted_at.toISOString()
        : row.accepted_at,
  }
}

export function hasScoreMismatch(row) {
  return (
    row.point_delta !== 0 ||
    row.missing_result === true ||
    row.missing_outbox > 0 ||
    row.pending_score_events > 0
  )
}

export async function readExportSnapshot(client, roomId) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    const scoresQuery = resultsSql(roomId)
    const answersQuery = answersSql(roomId)
    const scores = await client.query(scoresQuery.text, scoresQuery.values)
    const answers = await client.query(answersQuery.text, answersQuery.values)
    await client.query("COMMIT")
    return { scores: scores.rows, answers: answers.rows }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
