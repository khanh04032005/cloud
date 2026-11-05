import { zValidator } from "@hono/zod-validator"
import type { QuizzWithId } from "@razzia/common/types/game"
import {
  checkGameValidator,
  createGameValidator,
  gameSettingsValidator,
  joinGameValidator,
} from "@razzia/common/validators/game"
import { apiFactory } from "@razzia/socket/api/factory"
import { requireManager, requireSession } from "@razzia/socket/api/middleware"
import { i18nHook } from "@razzia/socket/api/validation"
import { updateCloudRoomSettings } from "@razzia/socket/handlers/game"
import { mintJoinTicket } from "@razzia/socket/services/auth"
import { getQuizzById } from "@razzia/socket/services/catalog"
import { cloud, type RoomAdmission } from "@razzia/socket/services/cloud"
import Game from "@razzia/socket/services/game"
import { getIo } from "@razzia/socket/services/io"
import Registry from "@razzia/socket/services/registry"
import { StatusCodes } from "http-status-codes"

const findRoom = (
  inviteCode: string,
  clientId?: string,
): RoomAdmission | undefined | Promise<RoomAdmission | undefined> => {
  if (cloud) {
    return cloud.findRoom(inviteCode, clientId)
  }

  const game = Registry.getInstance().getGameByInviteCode(inviteCode)

  if (!game) {
    return undefined
  }

  return {
    gameId: game.gameId,
    hostClientId: game.manager.clientId,
    settings: game.settings,
    locked: game.locked,
    username:
      game.players.find((player) => player.clientId === clientId)?.username ??
      null,
  }
}

const createGame = async (
  hostId: string,
  quiz: QuizzWithId,
  attempts = 5,
): Promise<Game | undefined> => {
  if (attempts === 0) {
    return undefined
  }

  const game = new Game(getIo(), hostId, quiz)

  if (cloud && !(await cloud.createRoom(game, quiz))) {
    return createGame(hostId, quiz, attempts - 1)
  }

  const registry = Registry.getInstance()
  registry.addGame(game)
  registry.markGameAsEmpty(game)

  return game
}

const routes = apiFactory
  .createApp()
  .post(
    "/",
    requireManager,
    zValidator("json", createGameValidator, i18nHook),
    async (c) => {
      const { quizzId } = c.req.valid("json")
      const quiz = await getQuizzById(quizzId)
      const game = await createGame(c.get("claims").sub, quiz)

      if (game) {
        return c.json(
          { gameId: game.gameId, inviteCode: game.inviteCode },
          StatusCodes.CREATED,
        )
      }

      return c.json(
        { error: "errors:api.serverError" },
        StatusCodes.SERVICE_UNAVAILABLE,
      )
    },
  )
  .patch(
    "/:gameId/settings",
    requireManager,
    zValidator("json", gameSettingsValidator, i18nHook),
    async (c) => {
      if (cloud) {
        const reply = await updateCloudRoomSettings(
          c.req.param("gameId"),
          c.get("claims").sub,
          c.req.valid("json"),
        )

        if (reply === "started") {
          return c.json(
            { error: "errors:game.alreadyStarted" },
            StatusCodes.CONFLICT,
          )
        }

        if (reply === "missing") {
          return c.json(
            { error: "errors:game.notFound" },
            StatusCodes.NOT_FOUND,
          )
        }

        if (typeof reply === "object" && "settings" in reply) {
          return c.json(reply)
        }

        return c.json(
          { error: "errors:api.serverError" },
          StatusCodes.SERVICE_UNAVAILABLE,
        )
      }

      const game = Registry.getInstance().getGameById(c.req.param("gameId"))

      if (!game || game.manager.clientId !== c.get("claims").sub) {
        return c.json({ error: "errors:game.notFound" }, StatusCodes.NOT_FOUND)
      }

      if (!game.updateSettings(c.req.valid("json"))) {
        return c.json(
          { error: "errors:game.alreadyStarted" },
          StatusCodes.CONFLICT,
        )
      }

      return c.json({ settings: game.settings })
    },
  )
  .post(
    "/check",
    zValidator("json", checkGameValidator, i18nHook),
    async (c) => {
      const { inviteCode } = c.req.valid("json")
      const game = await findRoom(inviteCode)

      if (!game) {
        return c.json({ error: "errors:game.notFound" }, StatusCodes.NOT_FOUND)
      }

      if (game.locked) {
        return c.json({ error: "errors:game.locked" }, StatusCodes.FORBIDDEN)
      }

      return c.json({ generatedUsernames: game.settings.generatedUsernames })
    },
  )
  .post(
    "/join",
    requireSession,
    zValidator("json", joinGameValidator, i18nHook),
    async (c) => {
      const { inviteCode, username } = c.req.valid("json")
      const { sub } = c.get("claims")
      const game = await findRoom(inviteCode, sub)

      if (!game) {
        return c.json({ error: "errors:game.notFound" }, StatusCodes.NOT_FOUND)
      }

      if (game.hostClientId === sub) {
        return c.json(
          { error: "errors:game.managerCannotJoin" },
          StatusCodes.FORBIDDEN,
        )
      }

      if (game.username !== null) {
        return c.json({
          gameId: game.gameId,
          ticket: null,
          username: game.username,
        })
      }

      if (game.locked) {
        return c.json({ error: "errors:game.locked" }, StatusCodes.FORBIDDEN)
      }

      if (!game.settings.generatedUsernames && !username) {
        return c.json(
          { error: "errors:auth.usernameTooShort" },
          StatusCodes.BAD_REQUEST,
        )
      }

      const name = game.settings.generatedUsernames ? undefined : username

      return c.json({
        gameId: game.gameId,
        ticket: await mintJoinTicket(sub, game.gameId, name),
        username: name ?? null,
      })
    },
  )

export const games = routes
