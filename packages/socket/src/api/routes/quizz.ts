import { zValidator } from "@hono/zod-validator"
import { quizzValidator } from "@razzia/common/validators/quizz"
import { apiFactory } from "@razzia/socket/api/factory"
import { requireManager } from "@razzia/socket/api/middleware"
import { i18nHook } from "@razzia/socket/api/validation"
import {
  deleteQuizz,
  getQuizzById,
  getQuizzMeta,
  saveQuizz,
  updateQuizz,
} from "@razzia/socket/services/catalog"
import { StatusCodes } from "http-status-codes"

const routes = apiFactory
  .createApp()
  .use(requireManager)
  .get("/", async (c) => c.json({ quizz: await getQuizzMeta() }))
  .get("/:id", async (c) => c.json(await getQuizzById(c.req.param("id"))))
  .post("/", zValidator("json", quizzValidator, i18nHook), async (c) =>
    c.json(await saveQuizz(c.req.valid("json")), StatusCodes.CREATED),
  )
  .patch("/:id", zValidator("json", quizzValidator, i18nHook), async (c) =>
    c.json(await updateQuizz(c.req.param("id"), c.req.valid("json"))),
  )
  .delete("/:id", async (c) => {
    await deleteQuizz(c.req.param("id"))

    return c.body(null, StatusCodes.NO_CONTENT)
  })

export const quizz = routes
