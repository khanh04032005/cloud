/** Rules the import Lambda and the OpenTrivia converter both enforce.
 *  They match Razzia 4.0.2 (commit 8345663f7f): 2–4 answers, cooldown 3–15,
 *  and the course MVP: one correct choice, speed does not change the stored point.
 */

export const LIMITS = {
  minAnswers: 2,
  maxAnswers: 4,
  minCooldown: 3,
  maxCooldown: 15,
  minTime: 5,
  maxTime: 120,
}

export function validateRazziaQuiz(doc) {
  const errors = []

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["Quiz phải là một object JSON."] }
  }

  if (doc.gameMode !== "quiz") {
    errors.push('gameMode phải là "quiz".')
  }

  if (typeof doc.subject !== "string" || doc.subject.trim() === "") {
    errors.push("subject không được rỗng.")
  }

  if (!Array.isArray(doc.questions) || doc.questions.length === 0) {
    errors.push("questions phải là mảng có ít nhất một câu.")
  }

  const questions = Array.isArray(doc.questions) ? doc.questions : []

  questions.forEach((question, index) => {
    const where = `questions[${index}]`

    if (!question || typeof question !== "object") {
      errors.push(`${where} không phải object.`)
      return
    }

    if (question.type !== undefined && question.type !== "single") {
      errors.push(`${where}.type phải là "single" (MVP chỉ một đáp án đúng).`)
    }

    if (typeof question.question !== "string" || question.question.trim() === "") {
      errors.push(`${where}.question rỗng.`)
    }

    if (
      !Array.isArray(question.answers) ||
      question.answers.length < LIMITS.minAnswers ||
      question.answers.length > LIMITS.maxAnswers ||
      question.answers.some((answer) => typeof answer !== "string" || answer.trim() === "")
    ) {
      errors.push(
        `${where}.answers cần ${LIMITS.minAnswers}–${LIMITS.maxAnswers} chuỗi khác rỗng.`,
      )
    }

    const solutionOk =
      Array.isArray(question.solutions) &&
      question.solutions.length === 1 &&
      Number.isInteger(question.solutions[0]) &&
      question.solutions[0] >= 0 &&
      question.solutions[0] < (question.answers?.length ?? 0)

    if (!solutionOk) {
      errors.push(`${where}.solutions phải là đúng một chỉ số hợp lệ.`)
    }

    if (
      !Number.isInteger(question.cooldown) ||
      question.cooldown < LIMITS.minCooldown ||
      question.cooldown > LIMITS.maxCooldown
    ) {
      errors.push(
        `${where}.cooldown phải là số nguyên ${LIMITS.minCooldown}–${LIMITS.maxCooldown}.`,
      )
    }

    if (
      !Number.isInteger(question.time) ||
      question.time < LIMITS.minTime ||
      question.time > LIMITS.maxTime
    ) {
      errors.push(
        `${where}.time phải là số nguyên ${LIMITS.minTime}–${LIMITS.maxTime}.`,
      )
    }

    if (
      question.maxPoints !== undefined &&
      (!Number.isInteger(question.maxPoints) || question.maxPoints < 0)
    ) {
      errors.push(`${where}.maxPoints phải là số nguyên ≥ 0.`)
    }
  })

  return { ok: errors.length === 0, errors }
}
