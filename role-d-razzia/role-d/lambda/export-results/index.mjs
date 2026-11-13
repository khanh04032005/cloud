import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import pg from "pg"
import {
  ANSWER_HEADERS,
  RESULTS_HEADERS,
  answersSql,
  assignRanks,
  exportKeys,
  resultsSql,
  shapeAnswerRow,
  toCsv,
} from "./logic.mjs"

const s3 = new S3Client({})
let pool

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required")
    }

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
    })
  }

  return pool
}

export async function handler(event = {}) {
  const bucket = process.env.EXPORT_BUCKET

  if (!bucket) {
    throw new Error("EXPORT_BUCKET is required")
  }

  const roomId = event.roomId ?? event.room_id ?? null
  const client = await getPool().connect()

  try {
    const scores = await client.query(resultsSql(roomId))
    const answers = await client.query(answersSql(roomId))
    const ranked = assignRanks(
      scores.rows.map((row) => ({
        ...row,
        points: Number(row.points),
        correct_answers: Number(row.correct_answers),
        accepted_answers: Number(row.accepted_answers),
      })),
    )
    const keys = exportKeys(roomId)
    const resultsBody = toCsv(RESULTS_HEADERS, ranked)
    const answersBody = toCsv(ANSWER_HEADERS, answers.rows.map(shapeAnswerRow))

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keys.results,
        Body: resultsBody,
        ContentType: "text/csv; charset=utf-8",
      }),
    )
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keys.answers,
        Body: answersBody,
        ContentType: "text/csv; charset=utf-8",
      }),
    )

    const mismatches = ranked.filter((row) => row.points !== row.correct_answers)

    return {
      bucket,
      keys,
      players: ranked.length,
      answers: answers.rows.length,
      mismatches: mismatches.length,
    }
  } finally {
    client.release()
  }
}
