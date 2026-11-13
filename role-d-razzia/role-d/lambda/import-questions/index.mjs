import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import pg from "pg"
import { buildImportPlan, isUniqueViolation } from "./logic.mjs"

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

async function readBody(bucket, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const bytes = await response.Body.transformToByteArray()

  return {
    body: Buffer.from(bytes),
    etag: (response.ETag ?? "").replaceAll('"', ""),
  }
}

export async function handler(event) {
  const license = process.env.QUESTION_LICENSE ?? "CC BY-SA 4.0"
  const results = []

  for (const record of event.Records ?? []) {
    const bucket = record.s3.bucket.name
    const key = decodeURIComponent(record.s3.object.key.replaceAll("+", " "))

    if (!key.endsWith(".json") || key.includes("/_")) {
      results.push({ key, status: "ignored" })
      continue
    }

    const object = await readBody(bucket, key)
    const plan = buildImportPlan({
      bucket,
      key,
      etag: object.etag || record.s3.object.eTag?.replaceAll('"', "") || "missing-etag",
      body: object.body,
      license,
    })

    if (!plan.ok) {
      console.error(JSON.stringify({ key, error: plan.error }))
      throw new Error(`Invalid quiz ${key}: ${plan.error}`)
    }

    const client = await getPool().connect()

    try {
      await client.query("BEGIN")

      for (const statement of plan.statements) {
        await client.query(statement.text, statement.values)
      }

      await client.query("COMMIT")
      results.push({
        key,
        status: "imported",
        questionSetId: plan.setId,
        questions: plan.questionCount,
        sha256: plan.sha256,
      })
    } catch (error) {
      await client.query("ROLLBACK")

      if (isUniqueViolation(error)) {
        results.push({ key, status: "duplicate", etag: object.etag })
        continue
      }

      throw error
    } finally {
      client.release()
    }
  }

  return { results }
}
