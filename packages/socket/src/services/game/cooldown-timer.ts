import { EVENTS, NO_TIME_LIMIT } from "@razzia/common/constants"
import type { Server } from "@razzia/common/types/game/socket"
import { SECOND_MS } from "@razzia/socket/utils/sleep"

export class CooldownTimer {
  private readonly io: Server
  private readonly gameId: string
  private readonly canRun: () => boolean
  private timer: ReturnType<typeof setInterval> | null = null
  private aborted = false
  private complete: (() => void) | null = null

  constructor(io: Server, gameId: string, canRun: () => boolean = () => true) {
    this.io = io
    this.gameId = gameId
    this.canRun = canRun
  }

  start(seconds: number): Promise<void> {
    return this.until(
      seconds === NO_TIME_LIMIT
        ? null
        : new Date(Date.now() + seconds * SECOND_MS),
    )
  }

  until(deadline: Date | null): Promise<void> {
    if (this.complete) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.complete = resolve
      this.aborted = false
      let previous = -1
      const tick = () => {
        if (
          this.aborted ||
          !this.canRun() ||
          (deadline && Date.now() >= deadline.getTime())
        ) {
          this.finish()

          return
        }

        if (!deadline) {
          return
        }

        const remaining = Math.ceil(
          (deadline.getTime() - Date.now()) / SECOND_MS,
        )

        if (remaining !== previous) {
          previous = remaining
          this.io.to(this.gameId).emit(EVENTS.GAME.COOLDOWN, remaining)
        }
      }
      this.timer = setInterval(tick, Math.min(SECOND_MS, 1000))

      if (deadline && deadline.getTime() <= Date.now()) {
        this.finish()
      }
    })
  }

  abort() {
    this.aborted = true
  }

  private finish() {
    if (this.timer) {
      clearInterval(this.timer)
    }

    this.timer = null
    const resolve = this.complete
    this.complete = null
    resolve?.()
  }
}
