import { apiFactory } from "@razzia/socket/api/factory"
import { requireManager } from "@razzia/socket/api/middleware"
import {
  deleteResult,
  getResultById,
  getResultsMeta,
} from "@razzia/socket/services/reports"
import { StatusCodes } from "http-status-codes"

const routes = apiFactory
  .createApp()
  .use(requireManager)
  .get("/", async (c) => c.json({ results: await getResultsMeta() }))
  .get("/:id", async (c) => c.json(await getResultById(c.req.param("id"))))
  .delete("/:id", async (c) => {
    await deleteResult(c.req.param("id"))

    return c.body(null, StatusCodes.NO_CONTENT)
  })

export const results = routes
