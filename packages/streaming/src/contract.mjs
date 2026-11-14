export const TOPIC = "answers"

export function parseAnswerEvent(value) {
  const e = typeof value === "string" ? JSON.parse(value) : value

  if (!e || typeof e !== "object") {
    throw new Error("Answer event must be an object")
  }
  for (const key of ["event_id", "room_id", "round_id", "player_id"]) {
    if (typeof e[key] !== "string" || !e[key]) {
      throw new Error(`Invalid ${key}`)
    }
  }

  if (!Array.isArray(e.choice) || !e.choice.every(Number.isInteger)) {
    throw new Error("choice must be an array of integers")
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
