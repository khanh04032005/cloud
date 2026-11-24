import { STATUS } from "@razzia/common/types/game/status"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { Cloud } from "@razzia/socket/services/cloud"
import {
  RoomLease,
  acquireLease,
  renewLease,
  releaseLease,
  withLease,
} from "@razzia/socket/services/leases"
import { CloudGame } from "@razzia/socket/services/cloud-game"
import { applyScoreFixture } from "@razzia/socket/test/score-fixture"
import type { GameSocket } from "@razzia/socket/handlers/types"
import { ownedRoom } from "@razzia/socket/test/owned-room"

const database = process.env.CLOUD_TEST_DATABASE_URL
const redis = process.env.CLOUD_TEST_REDIS_URL
const enabled = Boolean(database && redis)
let storage: Cloud | undefined = undefined
const rooms: string[] = []

beforeAll(async () => {
  if (!database || !redis) {
    return
  }

  storage = new Cloud(database, redis)
  await storage.connect()
})

afterEach(async () => {
  await storage?.pool.query(
    "UPDATE rooms SET status = 'cancelled' WHERE id = ANY($1::uuid[]) AND status IN ('lobby', 'running')",
    [rooms],
  )
})

afterAll(async () => {
  if (!storage) {
    return
  }

  await storage.transaction(async (client) => {
    await client.query(
      "DELETE FROM processed_answer_events WHERE event_id IN (SELECT o.event_id FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = ANY($1::uuid[]))",
      [rooms],
    )
    await client.query(
      "DELETE FROM outbox WHERE round_id IN (SELECT id FROM rounds WHERE room_id = ANY($1::uuid[]))",
      [rooms],
    )
    await client.query("DELETE FROM answers WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM results WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query(
      "DELETE FROM game_reports WHERE room_id = ANY($1::uuid[])",
      [rooms],
    )
    await client.query("DELETE FROM rounds WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM players WHERE room_id = ANY($1::uuid[])", [
      rooms,
    ])
    await client.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [rooms])
  })
  await storage.close()
})

const fixture = async () => {
  if (!storage) {
    throw new Error("Cloud test storage is unavailable")
  }

  const record = await ownedRoom(storage)
  rooms.push(record.roomId)

  return record
}

it.skipIf(!enabled)(
  "commits one immutable answer and event under concurrent retries, including after close",
  async () => {
    const { storage: db, game, roomId, roundId, submission } = await fixture()
    const receipts = await Promise.all([
      game.accept(submission),
      game.accept({ ...submission, keys: [1] }),
    ])
    expect(receipts.map(({ status }) => status).sort()).toEqual([
      "accepted",
      "duplicate",
    ])
    expect(receipts[0].answerKeys).toEqual(receipts[1].answerKeys)
    expect(receipts[0]).not.toHaveProperty("is_correct")
    await db.pool.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
      roundId,
    ])
    await expect(
      game.accept({ ...submission, keys: [1] }),
    ).resolves.toMatchObject({
      status: "duplicate",
      answerKeys: receipts[0].answerKeys,
      acceptedAt: receipts[0].acceptedAt,
    })
    const {
      rows: [count],
    } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = $1",
      [roomId],
    )
    expect(count.count).toBe(1)
  },
)

it.skipIf(!enabled)(
  "rolls the answer back when the outbox insert fails",
  async () => {
    const { storage: db, game, roomId, roundId, submission } = await fixture()
    const name = `reject_outbox_${randomUUID().replaceAll("-", "")}`
    await db.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected outbox failure'; END $$`,
    )

    try {
      await db.pool.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.round_id = '${roundId}'::uuid) EXECUTE FUNCTION ${name}()`,
      )
      await expect(game.accept(submission)).rejects.toThrow(
        "Injected outbox failure",
      )
      const {
        rows: [count],
      } = await db.pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM answers WHERE room_id = $1",
        [roomId],
      )
      expect(count.count).toBe(0)
    } finally {
      await db.pool.query(`DROP TRIGGER IF EXISTS ${name} ON outbox`)
      await db.pool.query(`DROP FUNCTION ${name}()`)
    }

    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "accepted",
    })
  },
)

it.skipIf(!enabled)(
  "rejects expired, foreign and invalid submissions without creating events",
  async () => {
    const { storage: db, game, roundId, submission } = await fixture()
    await expect(
      game.accept({ ...submission, keys: [4] }),
    ).resolves.toMatchObject({ status: "invalid" })
    await expect(
      game.accept({ ...submission, playerId: randomUUID() }),
    ).resolves.toMatchObject({ status: "forbidden" })
    await expect(
      game.accept({ ...submission, socketId: "old-connection" }),
    ).resolves.toMatchObject({ status: "forbidden" })
    await db.pool.query(
      "UPDATE rounds SET closes_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [roundId],
    )
    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "closed",
    })
    const {
      rows: [count],
    } = await db.pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM answers WHERE round_id = $1",
      [roundId],
    )
    expect(count.count).toBe(0)
  },
)

it.skipIf(!enabled)(
  "checks the server deadline after waiting for a concurrent close transaction",
  async () => {
    const { storage: db, game, roundId, submission } = await fixture()
    const closer = await db.pool.connect()

    try {
      await closer.query("BEGIN")
      await closer.query("SELECT id FROM rounds WHERE id = $1 FOR UPDATE", [
        roundId,
      ])
      const receipt = game.accept(submission)
      await closer.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
        roundId,
      ])
      await closer.query("COMMIT")
      await expect(receipt).resolves.toMatchObject({ status: "closed" })
    } finally {
      await closer.query("ROLLBACK")
      closer.release()
    }
  },
)

it.skipIf(!enabled)(
  "restores accepted choice and worker score from DB with an empty Redis room cache",
  async () => {
    const {
      storage: db,
      game,
      roomId,
      playerId,
      socketId,
      submission,
    } = await fixture()
    await game.broadcast(
      {
        name: "SELECT_ANSWER",
        data: {
          question: "Test?",
          answers: ["Correct", "Wrong"],
          time: 30,
          totalPlayer: 1,
          questionType: "single",
          answersOnly: false,
        },
      },
      1,
    )
    await game.accept(submission)
    await applyScoreFixture(db.pool, roomId)
    await applyScoreFixture(db.pool, roomId)
    await db.redis.del(`razzia:room:${roomId}`)
    const socket = {
      id: "new-connection",
      data: { clientId: playerId, role: "player" },
    } as GameSocket
    const restored = await game.reconnect(socket)
    expect(restored?.player.id).toBe(socketId)
    expect(restored?.payload).toMatchObject({
      player: { points: 1 },
      status: { name: "WAIT" },
      acceptedAnswer: { answerKeys: [0] },
    })
    const scores = await game.scores(1)
    expect(scores).toMatchObject([{ points: 1, rank: 1 }])
  },
)

it.skipIf(!enabled)(
  "fences stale owners and preserves the successor lease on late renewal and release",
  async () => {
    const { storage: db, game, lease, roomId, submission } = await fixture()
    expect(await acquireLease(db, roomId)).toBeUndefined()
    await db.pool.query(
      "UPDATE rooms SET lease_until = '-infinity' WHERE id = $1",
      [roomId],
    )
    await db.redis.del(`razzia:lease:${roomId}`)
    const successor = await acquireLease(db, roomId)
    expect(successor?.epoch).toBe(lease.epoch + 1)

    if (!successor) {
      throw new Error("Successor missing")
    }

    await expect(game.accept(submission)).rejects.toThrow("Room lease lost")
    await expect(renewLease(db, lease)).rejects.toThrow("Room lease lost")
    await expect(
      db.phase(roomId, { phase: "closed", position: 1 }, lease),
    ).rejects.toThrow("Room lease lost")
    await releaseLease(db, lease)
    expect(await db.redis.get(`razzia:lease:${roomId}`)).toBe(successor.token)
    await expect(
      withLease(db, { gameId: roomId, lease: successor }, async (client) => {
        const { rows } = await client.query(
          "SELECT id FROM rooms WHERE id = $1",
          [roomId],
        )

        return rows.length
      }),
    ).resolves.toBe(1)
    await releaseLease(db, successor)
  },
)

it.skipIf(!enabled)(
  "keeps one answer and outbox event through a burst of 64 retries",
  async () => {
    const { storage: db, game, roomId, submission } = await fixture()
    const receipts = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        game.accept({ ...submission, keys: [index % 2] }),
      ),
    )
    expect(
      receipts.filter((receipt) => receipt.status === "accepted"),
    ).toHaveLength(1)
    expect(
      receipts.filter((receipt) => receipt.status === "duplicate"),
    ).toHaveLength(63)
    const canonical = receipts.find((receipt) => receipt.status === "accepted")
    expect(
      receipts.every(
        (receipt) =>
          JSON.stringify(receipt.answerKeys) ===
          JSON.stringify(canonical?.answerKeys),
      ),
    ).toBe(true)
    const {
      rows: [counts],
    } = await db.pool.query<{ answers: number; events: number }>(
      "SELECT (SELECT count(*)::integer FROM answers WHERE room_id = $1) AS answers, (SELECT count(*)::integer FROM outbox WHERE round_id IN (SELECT id FROM rounds WHERE room_id = $1)) AS events",
      [roomId],
    )
    expect(counts).toEqual({ answers: 1, events: 1 })
  },
)

it.skipIf(!enabled)(
  "commits final reconnect snapshots with the report before final socket notifications",
  async () => {
    const { storage: db, game, roomId, playerId, submission } = await fixture()
    await game.accept(submission)
    await applyScoreFixture(db.pool, roomId)
    await game.saveReport({
      id: randomUUID(),
      gameMode: "quiz",
      subject: "Atomic final",
      date: new Date().toISOString(),
      players: [{ username: "Test player", points: 1, rank: 1 }],
      questions: [],
    })
    const recovered = await new CloudGame(db, roomId).reconnect({
      id: "after-crash",
      data: { clientId: playerId, role: "player" },
    } as GameSocket)
    expect(recovered?.payload.status).toMatchObject({
      name: STATUS.FINISHED,
      data: { rank: 1, subject: "Atomic final" },
    })
  },
)

it.skipIf(!enabled)(
  "drops readiness when its Redis dependency is disconnected",
  async () => {
    if (!database || !redis) {
      throw new Error("Test dependencies unavailable")
    }

    const probe = new Cloud(database, redis)

    try {
      await probe.connect()
      expect(await probe.ready()).toBe(true)
      probe.redis.destroy()
      expect(await probe.ready()).toBe(false)
    } finally {
      await probe.close()
    }
  },
)

it.skipIf(!enabled)(
  "rejects a valid lease from another room before changing state",
  async () => {
    const target = await fixture()
    const other = await fixture()
    const before = (
      await target.storage.pool.query("SELECT * FROM rooms WHERE id = $1", [
        target.roomId,
      ])
    ).rows
    await expect(
      target.storage.phase(
        target.roomId,
        { phase: "closed", position: 1 },
        other.lease,
      ),
    ).rejects.toThrow("Room lease lost")
    const foreign = new CloudGame(target.storage, target.roomId)
    expect(() => foreign.attachLease(other.lease)).toThrow("Room lease lost")
    expect(
      (
        await target.storage.pool.query("SELECT * FROM rooms WHERE id = $1", [
          target.roomId,
        ])
      ).rows,
    ).toEqual(before)
  },
)

const committedPair = async (record: { storage: Cloud; roomId: string }) => {
  const answers = await record.storage.pool.query<Record<string, unknown>>(
    "SELECT * FROM answers WHERE room_id = $1 ORDER BY round_id, player_id",
    [record.roomId],
  )
  const outbox = await record.storage.pool.query<Record<string, unknown>>(
    "SELECT o.* FROM outbox o JOIN answers a USING (round_id, player_id) WHERE a.room_id = $1 ORDER BY o.event_id",
    [record.roomId],
  )

  return { answers: answers.rows, outbox: outbox.rows }
}

it
  .skipIf(!enabled)
  .each(["before-answer", "before-outbox", "after-outbox"] as const)(
  "commits answer/outbox together or rolls both back on failure %s",
  async (stage) => {
    const record = await fixture()
    const { storage: db, game, submission, roundId } = record
    const triggerName = `atomic_${randomUUID().replaceAll("-", "")}`
    const targetTable = stage === "before-answer" ? "answers" : "outbox"
    const timing = stage === "after-outbox" ? "AFTER" : "BEFORE"
    await db.pool.query(
      `CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Atomic test failure'; END $$`,
    )

    try {
      await db.pool.query(
        `CREATE TRIGGER ${triggerName} ${timing} INSERT ON ${targetTable} FOR EACH ROW WHEN (NEW.round_id = '${roundId}'::uuid) EXECUTE FUNCTION ${triggerName}()`,
      )
      await expect(game.accept(submission)).rejects.toThrow(
        "Atomic test failure",
      )
      expect(await committedPair(record)).toEqual({ answers: [], outbox: [] })
    } finally {
      await db.pool.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON ${targetTable}`,
      )
      await db.pool.query(`DROP FUNCTION ${triggerName}()`)
    }

    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "accepted",
    })
    const committed = await committedPair(record)
    expect(committed.answers).toHaveLength(1)
    expect(committed.outbox).toHaveLength(1)
    expect(committed.outbox[0]).toMatchObject({
      round_id: roundId,
      player_id: submission.playerId,
    })
    await expect(
      game.accept({ ...submission, keys: [1] }),
    ).resolves.toMatchObject({ status: "duplicate", answerKeys: [0] })
    expect(await committedPair(record)).toEqual(committed)
  },
)

it
  .skipIf(!enabled)
  .each(["pending", "closed", "expired", "cancelled", "finished"] as const)(
  "creates no answer or outbox outside the valid window: %s",
  async (state) => {
    const record = await fixture()
    const { storage: db, roomId, roundId, game, submission } = record

    if (state === "pending" || state === "closed") {
      await db.pool.query(
        "UPDATE rounds SET status = $2, closes_at = clock_timestamp() + interval '1 hour' WHERE id = $1",
        [roundId, state],
      )
    } else if (state === "expired") {
      await db.pool.query(
        "UPDATE rounds SET closes_at = clock_timestamp() WHERE id = $1",
        [roundId],
      )
    } else {
      await db.pool.query(
        "UPDATE rooms SET status = $2, finished_at = CASE WHEN $2 = 'finished' THEN clock_timestamp() ELSE NULL END WHERE id = $1",
        [roomId, state],
      )
    }

    await expect(game.accept(submission)).resolves.toMatchObject({
      status: "closed",
    })
    expect(await committedPair(record)).toEqual({ answers: [], outbox: [] })
  },
)

it.skipIf(!enabled)(
  "accepts within the window, but a retry after expiry preserves the committed answer",
  async () => {
    const record = await fixture()
    const receipt = await record.game.accept(record.submission)
    expect(receipt).toMatchObject({ status: "accepted", answerKeys: [0] })
    const committed = await committedPair(record)
    await record.storage.pool.query(
      "UPDATE rounds SET status = 'closed', closes_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [record.roundId],
    )
    await expect(
      record.game.accept({ ...record.submission, keys: [1] }),
    ).resolves.toEqual({ ...receipt, status: "duplicate" })
    expect(await committedPair(record)).toEqual(committed)
  },
)

it.skipIf(!enabled)(
  "rechecks the deadline after a submission waits for the room transaction lock",
  async () => {
    const record = await fixture()
    const blocker = await record.storage.pool.connect()

    try {
      await blocker.query("BEGIN")
      await blocker.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [
        record.roomId,
      ])
      const receipt = record.game.accept(record.submission)
      await blocker.query(
        "UPDATE rounds SET closes_at = clock_timestamp() WHERE id = $1",
        [record.roundId],
      )
      await blocker.query("COMMIT")
      await expect(receipt).resolves.toMatchObject({ status: "closed" })
      expect(await committedPair(record)).toEqual({ answers: [], outbox: [] })
    } finally {
      await blocker.query("ROLLBACK")
      blocker.release()
    }
  },
)

it
  .skipIf(!enabled)
  .each(["missing", "token", "epoch", "database-expiry"] as const)(
  "rejects all state writes with an invalid coordinator lease: %s",
  async (reason) => {
    const record = await fixture()
    const { storage: db, roomId, lease } = record
    const invalid =
      reason === "missing"
        ? undefined
        : new RoomLease({
            gameId: roomId,
            token: reason === "token" ? randomUUID() : lease.token,
            epoch: reason === "epoch" ? lease.epoch + 1 : lease.epoch,
            deadline: performance.now() + 60000,
          })

    if (reason === "database-expiry") {
      // Keep scanners out of this deliberately expired fixture.
      await db.pool.query(
        "UPDATE rooms SET status = 'cancelled', lease_until = '-infinity' WHERE id = $1",
        [roomId],
      )
    }

    const game = new CloudGame(db, roomId)

    if (invalid) {
      game.attachLease(invalid)
    }

    const state = async () => ({
      rooms: (
        await db.pool.query<Record<string, unknown>>(
          "SELECT * FROM rooms WHERE id = $1",
          [roomId],
        )
      ).rows,
      players: (
        await db.pool.query<Record<string, unknown>>(
          "SELECT * FROM players WHERE room_id = $1",
          [roomId],
        )
      ).rows,
      pair: await committedPair(record),
      lease: await db.redis.get(`razzia:lease:${roomId}`),
      cache: await db.redis.hGetAll(`razzia:room:${roomId}`),
    })
    const original = await state()
    const actions = [
      () => game.accept(record.submission),
      () =>
        game.broadcast(
          { name: STATUS.WAIT, data: { text: "invalid owner" } },
          2,
        ),
      () =>
        game.playerState(
          record.playerId,
          { name: STATUS.WAIT, data: { text: "invalid owner" } },
          2,
        ),
      () =>
        game.managerState(
          { name: STATUS.SHOW_ROOM, data: { text: "invalid owner" } },
          2,
          null,
        ),
      () => game.managerConnection("invalid-owner", true),
      () => db.phase(roomId, { phase: "closed", position: 1 }, invalid),
      () => db.removeRoom(roomId, invalid),
    ]
    for (const action of actions) {
      // oxlint-disable-next-line no-await-in-loop -- Check each rejected write before trying the next one.
      await expect(action()).rejects.toThrow("Room lease lost")
      // oxlint-disable-next-line no-await-in-loop -- Verify the snapshot after each individual attempt.
      expect(await state()).toEqual(original)
    }
  },
)

it.skipIf(!enabled)(
  "permits the current coordinator to persist game, player and host state",
  async () => {
    const record = await fixture()
    await record.game.broadcast(
      { name: STATUS.WAIT, data: { text: "valid owner" } },
      1,
    )
    await record.game.playerState(
      record.playerId,
      { name: STATUS.WAIT, data: { text: "valid player state" } },
      1,
    )
    await record.game.managerConnection("valid-host", true)
    const {
      rows: [room],
    } = await record.storage.pool.query<{
      runtime: { name: string }
      manager_socket_id: string
    }>("SELECT runtime, manager_socket_id FROM rooms WHERE id = $1", [
      record.roomId,
    ])
    expect(room.runtime.name).toBe(STATUS.WAIT)
    expect(room.manager_socket_id).toBe("valid-host")
    await expect(record.game.accept(record.submission)).resolves.toMatchObject({
      status: "accepted",
    })
  },
)

it.skipIf(!enabled)(
  "allows one answer per round and preserves the previous round when advancing",
  async () => {
    const record = await fixture()
    const first = await record.game.accept(record.submission)
    expect(first).toMatchObject({ status: "accepted", answerKeys: [0] })
    const roundId = randomUUID()
    await record.storage.transaction(async (client) => {
      await client.query("UPDATE rounds SET status = 'closed' WHERE id = $1", [
        record.roundId,
      ])
      await client.query(
        "INSERT INTO rounds (id, room_id, position, question_snapshot, status, closes_at) SELECT $1, room_id, 2, question_snapshot, 'open', clock_timestamp() + interval '1 minute' FROM rounds WHERE id = $2",
        [roundId, record.roundId],
      )
      await client.query(
        "UPDATE rooms SET current_position = 2 WHERE id = $1",
        [record.roomId],
      )
    })
    await expect(
      record.game.accept({
        ...record.submission,
        roundId,
        position: 2,
        keys: [1],
      }),
    ).resolves.toMatchObject({ status: "accepted", roundId, answerKeys: [1] })
    const committed = await committedPair(record)
    expect(committed.answers).toHaveLength(2)
    expect(committed.outbox).toHaveLength(2)
    await expect(
      record.game.accept({ ...record.submission, keys: [1] }),
    ).resolves.toEqual({ ...first, status: "duplicate" })
    await expect(
      record.game.accept({
        ...record.submission,
        roundId,
        position: 2,
        keys: [0],
      }),
    ).resolves.toMatchObject({ status: "duplicate", answerKeys: [1] })
    expect(await committedPair(record)).toEqual(committed)
  },
)

it.skipIf(!enabled).each([0, 1000])(
  "stores correctness and one point independently of quiz maxPoints=%s",
  async (maxPoints) => {
    const record = await fixture()
    await record.storage.pool.query(
      "UPDATE rounds SET question_snapshot = jsonb_set(question_snapshot, '{maxPoints}', to_jsonb($2::integer)) WHERE id = $1",
      [record.roundId, maxPoints],
    )
    await expect(record.game.accept(record.submission)).resolves.toMatchObject({
      status: "accepted",
    })
    expect(
      (
        await record.storage.pool.query<{ is_correct: boolean }>(
          "SELECT is_correct FROM answers WHERE round_id = $1",
          [record.roundId],
        )
      ).rows,
    ).toEqual([{ is_correct: true }])
    await applyScoreFixture(record.storage.pool, record.roomId)
    expect((await record.game.scores(1)).map(({ points }) => points)).toEqual([
      1,
    ])
  },
)
