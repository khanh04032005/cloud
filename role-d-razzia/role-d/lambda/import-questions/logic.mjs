import { createHash, randomUUID } from "node:crypto"
import { validateRazziaQuiz } from "./quiz-schema.mjs"

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

export function questionRows(setId, quiz) {
  return quiz.questions.map((question, position) => ({
    id: randomUUID(),
    setId,
    position,
    prompt: question.question.trim(),
    answers: question.answers.map((answer) => answer.trim()),
    solution: question.solutions[0],
    cooldownSeconds: question.cooldown,
    timeSeconds: question.time,
    maxPoints: question.maxPoints ?? 1,
  }))
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

  const digest = sha256(body)
  const setId = randomUUID()

  return {
    ok: true,
    setId,
    sha256: digest,
    questionCount: parsed.questions.length,
    statements: [
      {
        text: `INSERT INTO question_sets
          (id, subject, s3_bucket, s3_key, s3_etag, sha256, question_count, license, document)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        values: [
          setId,
          parsed.subject.trim(),
          bucket,
          key,
          etag,
          digest,
          parsed.questions.length,
          license,
          JSON.stringify(parsed),
        ],
      },
      ...questionRows(setId, parsed).map((row) => ({
        text: `INSERT INTO questions
          (id, set_id, position, prompt, answers, solution, cooldown_seconds, time_seconds, max_points)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        values: [
          row.id,
          row.setId,
          row.position,
          row.prompt,
          JSON.stringify(row.answers),
          row.solution,
          row.cooldownSeconds,
          row.timeSeconds,
          row.maxPoints,
        ],
      })),
    ],
  }
}

export function isUniqueViolation(error) {
  return error?.code === "23505"
}
