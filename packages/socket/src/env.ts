import { randomBytes } from "crypto"
import z from "zod"

const MIN_SECRET_LENGTH = 32

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional())

const envSchema = z
  .object({
    MANAGER_PASSWORD: optional(
      z.string().min(1, "MANAGER_PASSWORD cannot be empty"),
    ),
    JWT_SECRET: optional(
      z
        .string()
        .min(
          MIN_SECRET_LENGTH,
          `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
        ),
    ),
    DATABASE_URL: optional(z.url()),
    REDIS_URL: optional(z.url()),
    GAME_SPEED: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .positive("GAME_SPEED must be a positive number")
        .default(1),
    ),
  })
  .refine(
    (env) =>
      (!env.DATABASE_URL && !env.REDIS_URL) ||
      Boolean(env.DATABASE_URL && env.REDIS_URL && env.JWT_SECRET),
    "Cloud mode requires DATABASE_URL, REDIS_URL, and a shared JWT_SECRET",
  )

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  throw new Error(
    `Invalid environment:\n${parsed.error.issues
      .map((issue) => `  - ${issue.message}`)
      .join("\n")}`,
  )
}

export const managerPassword = parsed.data.MANAGER_PASSWORD

export const gameSpeed = parsed.data.GAME_SPEED

export const databaseUrl = parsed.data.DATABASE_URL

export const redisUrl = parsed.data.REDIS_URL

export const jwtSecret =
  parsed.data.JWT_SECRET ?? randomBytes(32).toString("hex")
