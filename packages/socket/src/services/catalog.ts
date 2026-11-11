import type { Question, Quizz, QuizzWithId } from "@razzia/common/types/game"
import { cloud } from "@razzia/socket/services/cloud"
import * as files from "@razzia/socket/services/config"
import { notFound } from "@razzia/socket/services/errors"
import { nanoid } from "nanoid"
import type { PoolClient } from "pg"

const writeQuestions = async (
  client: PoolClient,
  id: string,
  questions: Question[],
) => {
  await client.query("DELETE FROM questions WHERE quiz_id = $1", [id])
  await client.query(
    `INSERT INTO questions (quiz_id, position, definition)
     SELECT $1, position, definition
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(definition, position)`,
    [id, JSON.stringify(questions)],
  )
}

export const importFileQuizzes = async () => {
  if (!cloud) {
    return
  }

  await cloud.transaction(async (client) => {
    const marker = await client.query(
      "INSERT INTO data_imports (name) VALUES ('file-quizzes') ON CONFLICT DO NOTHING",
    )

    if (marker.rowCount === 0) {
      return
    }

    const quizzes = new Map(
      files
        .getQuizz()
        .reverse()
        .map((quiz) => [quiz.id, quiz]),
    )
    await client.query(
      `WITH source AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS quiz(id text, subject text, "gameMode" text, questions jsonb)
       ), added AS (
         INSERT INTO quizzes (id, subject, game_mode)
         SELECT id, subject, "gameMode" FROM source ON CONFLICT DO NOTHING RETURNING id
       )
       INSERT INTO questions (quiz_id, position, definition)
       SELECT added.id, entry.position, entry.definition
       FROM source JOIN added USING (id)
       CROSS JOIN jsonb_array_elements(source.questions) WITH ORDINALITY AS entry(definition, position)`,
      [JSON.stringify([...quizzes.values()])],
    )
  })
}

export const getQuizzMeta = async () => {
  if (!cloud) {
    return files.getQuizzMeta()
  }

  const { rows } = await cloud.pool.query<Pick<QuizzWithId, "id" | "subject">>(
    "SELECT id, subject FROM quizzes",
  )
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  })

  return rows.sort((a, b) => collator.compare(a.subject, b.subject))
}

export const getQuizzById = async (id: string): Promise<QuizzWithId> => {
  if (!cloud) {
    return files.getQuizzById(id)
  }

  const { rows } = await cloud.pool.query<QuizzWithId>(
    `SELECT q.id, q.subject, q.game_mode AS "gameMode",
        COALESCE(jsonb_agg(s.definition ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL), '[]') AS questions
     FROM quizzes AS q LEFT JOIN questions AS s ON s.quiz_id = q.id
     WHERE q.id = $1 GROUP BY q.id`,
    [id],
  )

  const quiz = rows.at(0)

  if (!quiz) {
    throw notFound("errors:quizz.notFound")
  }

  return quiz
}

export const saveQuizz = async (quiz: Quizz) => {
  if (!cloud) {
    return files.saveQuizz(quiz)
  }

  const id = nanoid()
  await cloud.transaction(async (client) => {
    await client.query(
      "INSERT INTO quizzes (id, subject, game_mode) VALUES ($1, $2, $3)",
      [id, quiz.subject, quiz.gameMode],
    )
    await writeQuestions(client, id, quiz.questions)
  })

  return { id }
}

export const updateQuizz = async (id: string, quiz: Quizz) => {
  if (!cloud) {
    return files.updateQuizz(id, quiz)
  }

  await cloud.transaction(async (client) => {
    const updated = await client.query(
      "UPDATE quizzes SET subject = $2, game_mode = $3 WHERE id = $1",
      [id, quiz.subject, quiz.gameMode],
    )

    if (updated.rowCount === 0) {
      throw notFound("errors:quizz.notFound")
    }

    await writeQuestions(client, id, quiz.questions)
  })

  return { id }
}

export const deleteQuizz = async (id: string) => {
  if (!cloud) {
    return files.deleteQuizz(id)
  }

  const deleted = await cloud.pool.query("DELETE FROM quizzes WHERE id = $1", [
    id,
  ])

  if (deleted.rowCount === 0) {
    throw notFound("errors:quizz.notFound")
  }
}
