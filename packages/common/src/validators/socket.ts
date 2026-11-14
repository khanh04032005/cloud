import { EVENTS, MAX_ANSWERS } from "@razzia/common/constants"
import { z } from "zod"

const gameMessageValidator = z.object({ gameId: z.string().min(1) })

const answerKeysValidator = z
  .array(z.number())
  .max(MAX_ANSWERS)
  .refine((keys) => new Set(keys).size === keys.length)

export const clientEventValidators = {
  [EVENTS.MANAGER.RECONNECT]: gameMessageValidator,
  [EVENTS.MANAGER.LEAVE]: gameMessageValidator,
  [EVENTS.MANAGER.KICK_PLAYER]: gameMessageValidator.extend({
    playerId: z.string().min(1),
  }),
  [EVENTS.MANAGER.START_GAME]: gameMessageValidator,
  [EVENTS.MANAGER.ADVANCE]: gameMessageValidator,
  [EVENTS.MANAGER.SET_LOCK]: gameMessageValidator.extend({
    locked: z.boolean(),
  }),
  [EVENTS.PLAYER.LOGIN]: z.object({ ticket: z.string().min(1) }),
  [EVENTS.PLAYER.RECONNECT]: gameMessageValidator,
  [EVENTS.PLAYER.LEAVE]: gameMessageValidator,
  [EVENTS.PLAYER.SELECTED_ANSWER]: gameMessageValidator.extend({
    roundId: z.uuid().optional(),
    data: z.object({ answerKeys: answerKeysValidator }),
  }),
}
