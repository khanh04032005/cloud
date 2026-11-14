// oxlint-disable typescript/no-unnecessary-condition
import {
  EVENTS,
  MAX_POINTS,
  MEDIA_TYPES,
  NO_TIME_LIMIT,
  QUIZZ_MODES,
} from "@razzia/common/constants"
import { isEstimationOptions } from "@razzia/common/questions/options"
import type {
  Answer,
  GameResult,
  GameSettings,
  GameUpdateQuestion,
  Player,
  Question,
  QuestionResult,
  Quizz,
  QuizzMode,
} from "@razzia/common/types/game"
import type { Server } from "@razzia/common/types/game/socket"
import {
  type Status,
  STATUS,
  type StatusDataMap,
} from "@razzia/common/types/game/status"
import type { GameSocket } from "@razzia/socket/handlers/types"
import type { CloudGame } from "@razzia/socket/services/cloud-game"
import type { RecoveredRoom } from "@razzia/socket/services/game/recovery-state"
import { CooldownTimer } from "@razzia/socket/services/game/cooldown-timer"
import { PlayerManager } from "@razzia/socket/services/game/player-manager"
import {
  countAnswers,
  scoreQuestion,
  type ScoredPlayer,
} from "@razzia/socket/services/scoring/round"
import { orderToPoint, timeToPoint } from "@razzia/socket/utils/game"
import sleep, { SECOND_MS } from "@razzia/socket/utils/sleep"
import { nanoid } from "nanoid"

type BroadcastFn = <T extends Status>(
  _status: T,
  _data: StatusDataMap[T],
  _deadline?: Date | null,
) => void | Promise<void>
type SendFn = <T extends Status>(
  _target: string,
  _status: T,
  _data: StatusDataMap[T],
) => void | Promise<void>

export interface RoundManagerOptions {
  quizz: Quizz
  players: PlayerManager
  cooldown: CooldownTimer
  io: Server
  gameId: string
  getManagerId: () => string
  broadcast: BroadcastFn
  send: SendFn
  onNewQuestion: () => void
  onGameFinished: (_result: GameResult) => void | Promise<void>
  persistence?: CloudGame
  savePhase?: (
    _phase: "running" | "open" | "closed" | "finished",
    _position?: number,
    _closesAt?: Date | null,
  ) => Promise<void>
  onFailure: (_error: unknown) => void
  getSettings: () => GameSettings
  canRun?: () => boolean
}

interface RoundStep {
  name: string
  gameModes: QuizzMode[]
  skip?: () => boolean
  enter: () => void | Promise<void>
  delay: (_settings: GameSettings) => number
}

export class RoundManager {
  private readonly opts: RoundManagerOptions
  private readonly steps: RoundStep[]
  completed = false
  private started = false
  private currentQuestion = 0
  private currentStep = -1
  private playersAnswers: Answer[] = []
  private startTime = 0
  private acceptingAnswers = false
  private leaderboard: Player[] = []
  private tempOldLeaderboard: Player[] | null = null
  private questionsHistory: QuestionResult[] = []
  private autoAdvanceTimer: NodeJS.Timeout | null = null
  private processing = false

  constructor(opts: RoundManagerOptions) {
    this.opts = opts

    const steps: RoundStep[] = [
      {
        name: "reveal",
        gameModes: [QUIZZ_MODES.QUIZ, QUIZZ_MODES.SURVEY],
        enter: () => this.showResults(),
        delay: (settings) => settings.autoAdvance.responsesDelay,
      },
      {
        name: "leaderboard",
        gameModes: [QUIZZ_MODES.QUIZ],
        skip: () => this.isLastQuestion() || this.isSameCategoryNext(),
        enter: () => this.showLeaderboard(),
        delay: (settings) => settings.autoAdvance.leaderboardDelay,
      },
    ]

    this.steps = steps.filter((step) =>
      step.gameModes.includes(opts.quizz.gameMode),
    )
  }

  isStarted(): boolean {
    return this.started
  }

  stop(): void {
    this.started = false
    this.acceptingAnswers = false
  }

  private running(): boolean {
    return this.started && (this.opts.canRun?.() ?? true)
  }

  private get question(): Question {
    return this.opts.quizz.questions[this.currentQuestion]
  }

  private isAskingQuestion(): boolean {
    return this.currentStep < 0
  }

  private isLastQuestion(): boolean {
    return !this.opts.quizz.questions[this.currentQuestion + 1]
  }

  private isSameCategoryNext(): boolean {
    const category = this.question.category?.trim()
    const next = this.opts.quizz.questions[this.currentQuestion + 1]

    return Boolean(category) && next?.category?.trim() === category
  }

  private isSurvey(): boolean {
    return this.opts.quizz.gameMode === QUIZZ_MODES.SURVEY
  }

  // ── Auto advance ─────────────────────────────────────────────────────────

  clearAutoAdvance(): void {
    if (!this.autoAdvanceTimer) {
      return
    }

    clearInterval(this.autoAdvanceTimer)
    this.autoAdvanceTimer = null
    this.emitAutoAdvance(null)
  }

  private emitAutoAdvance(state: { seconds: number; total: number } | null) {
    if (!(this.opts.canRun?.() ?? true)) {
      return
    }

    this.opts.io
      .to(this.opts.getManagerId())
      .emit(EVENTS.MANAGER.AUTO_ADVANCE, state)
  }

  private scheduleAutoAdvance(delay: number, deadline?: Date | null): void {
    this.clearAutoAdvance()

    if (!this.opts.getSettings().autoAdvance.enable) {
      return
    }

    let remaining = deadline
      ? Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / SECOND_MS))
      : delay

    if (remaining === 0) {
      queueMicrotask(() => this.advance())

      return
    }

    this.emitAutoAdvance({ seconds: remaining, total: delay })

    this.autoAdvanceTimer = setInterval(() => {
      if (!this.running()) {
        this.clearAutoAdvance()

        return
      }

      remaining -= 1

      if (remaining > 0) {
        this.emitAutoAdvance({ seconds: remaining, total: delay })

        return
      }

      this.clearAutoAdvance()
      this.advance()
    }, SECOND_MS)
  }

  // ── Flow ─────────────────────────────────────────────────────────────────

  getReconnectInfo(): GameUpdateQuestion | null {
    if (!this.running()) {
      return null
    }

    return {
      current: this.currentQuestion + 1,
      total: this.opts.quizz.questions.length,
    }
  }

  get position(): number {
    return this.currentQuestion + 1
  }

  async start(socket: GameSocket): Promise<void> {
    if (this.started) {
      return
    }

    if (this.opts.players.count() === 0) {
      socket.emit(EVENTS.GAME.ERROR_MESSAGE, "errors:game.noPlayersConnected")

      return
    }

    this.started = true

    if (this.opts.savePhase) {
      await this.opts.savePhase("running")
    }

    await this.opts.broadcast(
      STATUS.SHOW_START,
      {
        time: 3,
        subject: this.opts.quizz.subject,
      },
      new Date(Date.now() + 6 * SECOND_MS),
    )

    const countdown = this.startCountdown()

    if (this.opts.savePhase) {
      // The coordinator can process joins once the initial database writes commit.
      void countdown.catch(this.opts.onFailure)

      return
    }

    await countdown
  }

  private async startCountdown(): Promise<void> {
    await sleep(3)

    if (!this.running()) {
      return
    }

    this.opts.io.to(this.opts.gameId).emit(EVENTS.GAME.START_COOLDOWN)
    await this.opts.cooldown.start(3)

    this.beginQuestion()
  }

  advance(): void {
    if (!this.running() || this.processing) {
      return
    }

    this.clearAutoAdvance()

    if (this.isAskingQuestion()) {
      this.acceptingAnswers = false
      this.opts.cooldown.abort()

      return
    }

    this.runStep(this.currentStep + 1)
  }

  private runStep(index: number): void {
    const step = this.steps[index]

    if (!step) {
      this.nextQuestion()

      return
    }

    if (step.skip?.()) {
      this.runStep(index + 1)

      return
    }

    this.currentStep = index
    const entered = step.enter()

    if (entered instanceof Promise) {
      this.processing = true
      void entered
        .then(() => {
          this.processing = false

          if (this.running()) {
            this.scheduleAutoAdvance(step.delay(this.opts.getSettings()))
          }
        })
        .catch(this.opts.onFailure)
    } else {
      this.scheduleAutoAdvance(step.delay(this.opts.getSettings()))
    }
  }

  private nextQuestion(): void {
    if (this.isLastQuestion()) {
      void this.finish()

      return
    }

    this.currentQuestion += 1
    this.beginQuestion()
  }

  private beginQuestion(): void {
    void this.newQuestion().catch(this.opts.onFailure)
  }

  private async pauseUntil(deadline: Date) {
    if (this.running()) {
      await sleep(Math.max(0, (deadline.getTime() - Date.now()) / SECOND_MS))
    }
  }

  private async newQuestion(): Promise<void> {
    if (!this.running()) {
      return
    }

    this.currentStep = -1
    this.opts.onNewQuestion()
    this.opts.io.to(this.opts.gameId).emit(EVENTS.GAME.UPDATE_QUESTION, {
      current: this.position,
      total: this.opts.quizz.questions.length,
    })
    const deadline = new Date(Date.now() + 2 * SECOND_MS)
    await this.opts.broadcast(
      STATUS.SHOW_PREPARED,
      {
        totalAnswers: this.question.answers.length,
        questionNumber: this.position,
        questionType: this.question.type,
      },
      deadline,
    )
    await this.pauseUntil(deadline)
    await this.showQuestion()
  }

  private async showQuestion() {
    if (!this.running()) {
      return
    }

    const deadline = new Date(Date.now() + this.question.cooldown * SECOND_MS)
    const media =
      this.question.media?.type === MEDIA_TYPES.IMAGE
        ? this.question.media
        : undefined
    await this.opts.broadcast(
      STATUS.SHOW_QUESTION,
      {
        question: this.question.question,
        media,
        cooldown: this.question.cooldown,
      },
      deadline,
    )
    await this.pauseUntil(deadline)
    await this.openAnswers()
  }

  private async openAnswers() {
    if (!this.running()) {
      return
    }

    this.startTime = Date.now()
    const deadline =
      this.question.time === NO_TIME_LIMIT
        ? null
        : new Date(this.startTime + this.question.time * SECOND_MS)

    if (this.opts.savePhase) {
      await this.opts.savePhase("open", this.position, deadline)
    }

    if (!this.running()) {
      return
    }

    await this.publishAnswers(deadline)
    await this.answerWindow(deadline)
  }

  private async publishAnswers(deadline: Date | null) {
    const roundId = await this.opts.persistence?.roundId(this.position)
    await this.opts.broadcast(
      STATUS.SELECT_ANSWER,
      {
        ...(roundId && { roundId }),
        question: this.question.question,
        answers: this.question.answers,
        media: this.question.media,
        time: this.question.time,
        totalPlayer: this.opts.players.count(),
        questionType: this.question.type,
        options: this.question.options,
        answersOnly: this.opts.getSettings().answersOnly,
      },
      deadline,
    )
  }

  private async answerWindow(deadline: Date | null) {
    if (!this.running()) {
      return
    }

    this.acceptingAnswers = true

    const waiting = this.opts.cooldown.until(deadline)

    this.endIfEveryoneAnswered()

    await waiting
    this.acceptingAnswers = false

    if (!this.running()) {
      return
    }

    if (this.opts.savePhase) {
      await this.opts.savePhase("closed", this.position)
    }

    if (!this.running()) {
      return
    }

    this.runStep(0)
  }

  restore(snapshot: RecoveredRoom) {
    this.currentQuestion = Math.max(0, snapshot.current_position - 1)
    this.started = snapshot.status === "running"

    this.questionsHistory = snapshot.history
    this.playersAnswers = snapshot.answers
    this.leaderboard = snapshot.members.map((player) => ({ ...player }))
    this.currentStep = -1
    this.processing = false

    if (!this.started) {
      return
    }

    void this.resumeStage(snapshot).catch(this.opts.onFailure)
  }

  private async resumeStage(snapshot: RecoveredRoom) {
    if (!this.running()) {
      return
    }

    if (snapshot.round_status === "open") {
      if (snapshot.runtime?.name !== STATUS.SELECT_ANSWER) {
        await this.publishAnswers(snapshot.closes_at)
      }

      await this.answerWindow(snapshot.closes_at)

      return
    }

    if (snapshot.round_status === "closed") {
      const state =
        snapshot.host_state_position === snapshot.current_position
          ? snapshot.host_state
          : null

      if (
        state?.name === STATUS.SHOW_RESPONSES ||
        state?.name === STATUS.SHOW_LEADERBOARD
      ) {
        this.currentStep = state.name === STATUS.SHOW_RESPONSES ? 0 : 1
        const step = this.steps[this.currentStep]
        this.scheduleAutoAdvance(
          step.delay(this.opts.getSettings()),
          snapshot.auto_advance_at,
        )
      } else {
        this.runStep(0)
      }

      return
    }

    const stage = snapshot.runtime?.name
    let fallback = 6

    if (stage === STATUS.SHOW_PREPARED) {
      fallback = 2
    }

    if (stage === STATUS.SHOW_QUESTION) {
      fallback = this.question.cooldown
    }

    const deadline =
      snapshot.stage_deadline ?? new Date(Date.now() + fallback * SECOND_MS)
    await this.pauseUntil(deadline)

    if (!this.running()) {
      return
    }

    if (stage === STATUS.SHOW_PREPARED) {
      await this.showQuestion()
    } else if (stage === STATUS.SHOW_QUESTION) {
      await this.openAnswers()
    } else {
      await this.newQuestion()
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private recordHistory(players: Player[], scored: ScoredPlayer[] = []): void {
    this.questionsHistory.push({
      ...this.question,
      solutions: this.isSurvey() ? undefined : this.question.solutions,
      playerAnswers: players.map((player) => {
        const score = scored.find((s) => s.id === player.id)

        return {
          playerName: player.username,
          answerIds:
            this.playersAnswers.find((a) => a.playerId === player.id)
              ?.answerIds ?? null,
          ...(score && {
            correct: score.lastCorrect,
            points: score.lastPoints,
          }),
        }
      }),
    })
  }

  private showResults(): void | Promise<void> {
    if (this.opts.persistence) {
      return this.showCloudResults(this.opts.persistence)
    }

    const currentPlayers = this.opts.players.getAll()
    const answerCounts = countAnswers(this.playersAnswers)

    if (this.isSurvey()) {
      this.opts.send(this.opts.getManagerId(), STATUS.SHOW_RESPONSES, {
        ...this.question,
        solutions: undefined,
        responses: answerCounts,
      })

      currentPlayers.forEach((player) => {
        this.opts.send(player.id, STATUS.WAIT, {
          text: "game:answerNoted",
        })
      })

      this.recordHistory(currentPlayers)
      this.playersAnswers = []

      return
    }

    const oldLeaderboard = (() => {
      if (this.leaderboard.length === 0) {
        return currentPlayers.map((p) => ({ ...p }))
      }

      return this.leaderboard.map((p) => ({ ...p }))
    })()

    const sortedPlayers = scoreQuestion(
      this.question,
      currentPlayers,
      this.playersAnswers,
    )

    this.opts.players.replace(sortedPlayers)

    sortedPlayers.forEach((player, index) => {
      const aheadPlayer = sortedPlayers[index - 1]

      this.opts.send(player.id, STATUS.SHOW_RESULT, {
        correct: player.lastCorrect,
        message: player.lastCorrect ? "game:correct" : "game:wrong",
        points: player.lastPoints,
        myPoints: player.points,
        rank: player.rank ?? index + 1,
        aheadOfMe: aheadPlayer ? aheadPlayer.username : null,
      })
    })

    this.opts.send(this.opts.getManagerId(), STATUS.SHOW_RESPONSES, {
      ...this.question,
      responses: answerCounts,
    })

    this.recordHistory(currentPlayers, sortedPlayers)

    this.leaderboard = sortedPlayers
    this.tempOldLeaderboard ??= oldLeaderboard
    this.playersAnswers = []
  }

  private async showCloudResults(persistence: CloudGame) {
    if (
      !(await persistence.waitForScores(this.position, () => this.running()))
    ) {
      return
    }

    const scored = await persistence.scores(this.position)
    const oldLeaderboard = this.leaderboard.length
      ? this.leaderboard
      : this.opts.players.getAll().map((player) => ({ ...player }))
    this.playersAnswers = scored
      .filter((player) => player.answer_keys !== null)
      .map((player) => ({
        playerId: player.id,
        answerIds: player.answer_keys ?? [],
        points: player.lastPoints,
      }))
    const active = scored.filter((player) => player.active)
    this.opts.players.replace(active)
    this.recordHistory(scored, this.isSurvey() ? [] : scored)
    await Promise.all(
      active.map((player, index) =>
        Promise.resolve(
          this.opts.send(
            player.id,
            this.isSurvey() ? STATUS.WAIT : STATUS.SHOW_RESULT,
            this.isSurvey()
              ? { text: "game:answerNoted" }
              : {
                  correct: player.lastCorrect,
                  message: player.lastCorrect ? "game:correct" : "game:wrong",
                  points: player.lastPoints,
                  myPoints: player.points,
                  rank: player.rank ?? index + 1,
                  aheadOfMe:
                    active.find((other) => other.points > player.points)
                      ?.username ?? null,
                },
          ),
        ),
      ),
    )
    await this.opts.send(this.opts.getManagerId(), STATUS.SHOW_RESPONSES, {
      ...this.question,
      ...(this.isSurvey() && { solutions: undefined }),
      responses: countAnswers(this.playersAnswers),
    })
    this.leaderboard = active
    this.tempOldLeaderboard ??= oldLeaderboard
    this.playersAnswers = []
  }

  private showLeaderboard(): void | Promise<void> {
    const oldLeaderboard = this.tempOldLeaderboard ?? this.leaderboard

    const sent = this.opts.send(
      this.opts.getManagerId(),
      STATUS.SHOW_LEADERBOARD,
      {
        oldLeaderboard: oldLeaderboard.slice(0, 5),
        leaderboard: this.leaderboard.slice(0, 5),
      },
    )

    this.tempOldLeaderboard = null

    return sent
  }

  private finishSurvey(): void {
    const players = this.opts.players.getAll()

    const summary = {
      subject: this.opts.quizz.subject,
      totalPlayers: players.length,
      totalQuestions: this.opts.quizz.questions.length,
    }

    this.opts.send(this.opts.getManagerId(), STATUS.SUMMARY, summary)

    players.forEach((player) => {
      this.opts.send(player.id, STATUS.SUMMARY, summary)
    })
  }

  private finish(): void | Promise<void> {
    if (this.opts.persistence) {
      this.processing = true

      return this.finishCloud(this.opts.persistence)
        .then(() => {
          if (!this.started) {
            this.completed = true
          }
        })
        .catch(this.opts.onFailure)
    }

    this.started = false
    this.completed = true
    this.clearAutoAdvance()
    void this.opts.savePhase?.("finished").catch(this.opts.onFailure)

    const finalPlayers = this.isSurvey()
      ? this.opts.players.getAll()
      : this.leaderboard

    this.opts.onGameFinished({
      id: `${Date.now()}-${nanoid(8)}`,
      gameMode: this.opts.quizz.gameMode,
      subject: this.opts.quizz.subject,
      date: new Date().toISOString(),
      players: finalPlayers.map((player, index) => ({
        username: player.username,
        points: player.points,
        rank: player.rank ?? index + 1,
      })),
      questions: this.questionsHistory,
    })

    if (this.isSurvey()) {
      this.finishSurvey()

      return
    }

    const top = this.leaderboard
      .slice(0, 3)
      .map(({ username, points, rank }) => ({
        username,
        points,
        ...(rank && { rank }),
      }))

    this.opts.send(this.opts.getManagerId(), STATUS.FINISHED, {
      subject: this.opts.quizz.subject,
      top,
    })

    this.leaderboard.forEach((player, index) => {
      this.opts.send(player.id, STATUS.FINISHED, {
        subject: this.opts.quizz.subject,
        top,
        rank: player.rank ?? index + 1,
      })
    })
  }

  private async finishCloud(persistence: CloudGame) {
    this.clearAutoAdvance()

    if (!(await persistence.waitForScores(null, () => this.running()))) {
      return
    }

    const players = await persistence.scores(this.position)
    const report: GameResult = {
      id: `${Date.now()}-${nanoid(8)}`,
      gameMode: this.opts.quizz.gameMode,
      subject: this.opts.quizz.subject,
      date: new Date().toISOString(),
      players: players.map((player, index) => ({
        username: player.username,
        points: player.points,
        rank: player.rank ?? index + 1,
      })),
      questions: this.questionsHistory,
    }
    await this.opts.onGameFinished(report)
    await this.opts.savePhase?.("finished")
    this.started = false
    this.processing = false

    if (this.isSurvey()) {
      const data = {
        subject: report.subject,
        totalPlayers: players.length,
        totalQuestions: report.questions.length,
      }
      await persistence.broadcast({ name: STATUS.SUMMARY, data }, this.position)
      await Promise.all(
        [
          this.opts.getManagerId(),
          ...players
            .filter((player) => player.active)
            .map((player) => player.id),
        ].map((id) =>
          Promise.resolve(this.opts.send(id, STATUS.SUMMARY, data)),
        ),
      )

      return
    }

    const top = players
      .slice(0, 3)
      .map(({ username, points, rank }) => ({ username, points, rank }))
    const data = { subject: report.subject, top }
    await persistence.broadcast({ name: STATUS.FINISHED, data }, this.position)
    await this.opts.send(this.opts.getManagerId(), STATUS.FINISHED, data)
    await Promise.all(
      players
        .filter((player) => player.active)
        .map((player, index) =>
          Promise.resolve(
            this.opts.send(player.id, STATUS.FINISHED, {
              ...data,
              rank: player.rank ?? index + 1,
            }),
          ),
        ),
    )
  }

  // ── Player actions ───────────────────────────────────────────────────────

  private normalizeAnswer(answerIds: number[]): number[] | null {
    const { options } = this.question

    if (!isEstimationOptions(options)) {
      return answerIds
    }

    const value = answerIds.at(0)

    if (
      answerIds.length !== 1 ||
      value === undefined ||
      !Number.isFinite(value)
    ) {
      return null
    }

    return [Math.min(options.max, Math.max(options.min, value))]
  }

  selectAnswer(
    socket: GameSocket,
    answerIds: number[],
    roundId?: string,
  ): void | Promise<void> {
    if (this.opts.persistence) {
      return this.selectCloudAnswer(socket, answerIds, roundId)
    }

    const player = this.opts.players.findById(socket.id)

    if (!player || !this.acceptingAnswers) {
      return
    }

    if (this.playersAnswers.find((a) => a.playerId === socket.id)) {
      return
    }

    const submitted = this.normalizeAnswer(answerIds)

    if (!submitted) {
      return
    }

    const points = (() => {
      if (isEstimationOptions(this.question.options)) {
        return this.question.maxPoints ?? MAX_POINTS
      }

      if (this.question.time === NO_TIME_LIMIT) {
        return orderToPoint(
          this.playersAnswers.length,
          this.opts.players.count(),
          this.question.maxPoints,
        )
      }

      return timeToPoint(this.startTime, this.question)
    })()

    this.playersAnswers.push({
      playerId: player.id,
      answerIds: submitted,
      points,
    })

    this.opts.send(socket.id, STATUS.WAIT, {
      text: "game:waitingForAnswers",
    })

    socket
      .to(this.opts.gameId)
      .emit(EVENTS.GAME.PLAYER_ANSWER, this.playersAnswers.length)
    this.opts.players.broadcastCount()
    this.endIfEveryoneAnswered()
  }

  private async selectCloudAnswer(
    socket: GameSocket,
    keys: number[],
    roundId?: string,
  ) {
    const { persistence } = this.opts

    if (!persistence) {
      return
    }

    const receipt = await persistence.accept({
      playerId: socket.data.clientId,

      socketId: socket.id,
      position: this.position,
      roundId,
      keys,
    })
    socket.emit(EVENTS.PLAYER.ANSWER_ACK, receipt)

    if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
      return
    }

    if (
      !this.acceptingAnswers ||
      receipt.roundId !== (await persistence.roundId(this.position))
    ) {
      return
    }

    const player = this.opts.players.findById(socket.id)

    if (!player) {
      return
    }

    if (!this.playersAnswers.some((answer) => answer.playerId === player.id)) {
      this.playersAnswers.push({
        playerId: player.id,
        answerIds: receipt.answerKeys ?? [],
        points: 0,
      })
    }

    await this.opts.send(socket.id, STATUS.WAIT, {
      text: "game:waitingForAnswers",
    })
    socket
      .to(this.opts.gameId)
      .emit(EVENTS.GAME.PLAYER_ANSWER, this.playersAnswers.length)
    this.endIfEveryoneAnswered()
  }

  updatePlayerId(oldId: string, newId: string): void {
    this.playersAnswers = this.playersAnswers.map((answer) =>
      answer.playerId === oldId ? { ...answer, playerId: newId } : answer,
    )
  }

  endIfEveryoneAnswered(): void {
    if (!this.acceptingAnswers) {
      return
    }

    const connected = this.opts.players.getAll().filter((p) => p.connected)
    const everyoneAnswered = connected.every((player) =>
      this.playersAnswers.some((a) => a.playerId === player.id),
    )

    if (connected.length > 0 && everyoneAnswered) {
      this.opts.cooldown.abort()
    }
  }
}
