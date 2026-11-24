export const TOPIC = "answers"
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseAnswerEvent(value) {
  const e = typeof value === "string" ? JSON.parse(value) : value

  if (!e || typeof e !== "object") {
    throw new Error("Answer event must be an object")
  }
  for (const key of ["event_id", "room_id", "round_id", "player_id"]) {
    if (typeof e[key] !== "string" || !uuid.test(e[key])) {
      throw new Error(`Invalid ${key}`)
    }
  }

  if (e.choice !== null && (!Number.isInteger(e.choice) || e.choice < 0)) {
    throw new Error("choice must be a nonnegative integer or null")
  }
  // Estimation questions can store fractional or negative values in answer_keys.
  if (!Array.isArray(e.answer_keys) || !e.answer_keys.every(Number.isFinite)) {
    throw new Error("answer_keys must be an array of finite numbers")
  }

  if (typeof e.is_correct !== "boolean") {
    throw new Error("Invalid is_correct")
  }
  if (
    typeof e.accepted_at !== "string" ||
    !Number.isFinite(Date.parse(e.accepted_at))
  ) {
    throw new Error("Invalid accepted_at")
  }

  return e
}

export function secondBucket(acceptedAt) {
  return new Date(Math.floor(Date.parse(acceptedAt) / 1000) * 1000)
}
