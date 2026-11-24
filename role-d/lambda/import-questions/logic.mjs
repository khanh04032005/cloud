import { createHash, randomUUID } from "node:crypto"
import { validateRazziaQuiz } from "./quiz-schema.mjs"

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

export function buildImportPlan({ bucket, key, etag, body, license }) {
  let parsed
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, error: "File không phải JSON." }
  }
  const validated = validateRazziaQuiz(parsed)
  if (!validated.ok) {
    return { ok: false, error: validated.errors.join(" ") }
  }
  const quizId = randomUUID()
  const digest = sha256(body)
  return {
    ok: true,
    quizId,
    sha256: digest,
    questionCount: parsed.questions.length,
    statements: [
      {
        text: "INSERT INTO quizzes (id, subject, game_mode) VALUES ($1, $2, $3)",
        values: [quizId, parsed.subject.trim(), parsed.gameMode],
      },
      {
        text: `INSERT INTO quiz_imports
          (s3_bucket, s3_key, s3_etag, quiz_id, sha256, license)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (s3_bucket, s3_key, s3_etag) DO NOTHING RETURNING quiz_id`,
        values: [bucket, key, etag, quizId, digest, license],
      },
      {
        text: `INSERT INTO questions (quiz_id, position, definition)
          SELECT $1, position, definition
          FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(definition, position)`,
        values: [quizId, JSON.stringify(parsed.questions)],
      },
    ],
  }
}

export async function applyImportPlan(client, plan) {
  if (!plan.ok) {
    throw new Error("Cannot apply an invalid import plan")
  }
  await client.query("BEGIN")
  try {
    const [quiz, provenance, questions] = plan.statements
    await client.query(quiz.text, quiz.values)
    const inserted = await client.query(provenance.text, provenance.values)
    if (inserted.rows.length === 0) {
      // Roll back the new quiz too; a duplicate S3 delivery creates no orphan catalog.
      await client.query("ROLLBACK")
      return { status: "duplicate" }
    }
    await client.query(questions.text, questions.values)
    await client.query("COMMIT")
    return { status: "imported", quizId: plan.quizId }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
