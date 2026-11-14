import { roomLeaseTtlMs } from "@razzia/socket/env"
import type { Cloud } from "@razzia/socket/services/cloud"
import { metrics } from "@razzia/socket/services/metrics"
import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"

export const roomKey = (gameId: string) => `razzia:room:${gameId}`

const leaseKey = (gameId: string) => `razzia:lease:${gameId}`

export { LeaseLost }

import { LeaseLost } from "@razzia/socket/services/lease-lost"

export class RoomLease {
  readonly gameId: string
  readonly token: string
  readonly epoch: number
  private deadline: number
  private lost = false

  constructor(record: {
    gameId: string
    token: string
    epoch: number
    deadline: number
  }) {
    this.gameId = record.gameId
    this.token = record.token
    this.epoch = record.epoch
    this.deadline = record.deadline
  }

  get active() {
    return !this.lost && performance.now() < this.deadline
  }

  renew(deadline: number) {
    this.deadline = deadline
  }

  invalidate() {
    this.lost = true
  }
}

const deleteRedisLease = (storage: Cloud, lease: RoomLease) =>
  storage.redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
     return redis.call('DEL', KEYS[1], KEYS[2])
   end return 0`,
    {
      keys: [leaseKey(lease.gameId), roomKey(lease.gameId)],
      arguments: [lease.token],
    },
  )

export const assertLease = async (client: PoolClient, lease?: RoomLease) => {
  if (!lease?.active) {
    throw new LeaseLost(lease?.gameId ?? "unknown")
  }

  await client.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [
    lease.gameId,
  ])
  const { rows } = await client.query(
    "SELECT id FROM rooms WHERE id = $1 AND owner_token = $2 AND owner_epoch = $3 AND lease_until > clock_timestamp()",
    [lease.gameId, lease.token, lease.epoch],
  )

  if (!rows.length) {
    throw new LeaseLost(lease.gameId)
  }
}

export const withLease = <T>(
  storage: Cloud,
  lease: RoomLease | undefined,
  run: (_client: PoolClient) => Promise<T>,
) =>
  storage.transaction(async (client) => {
    await assertLease(client, lease)

    return run(client)
  })

/** The caller holds this transaction until the room and ownership are committed. */
export const acquireLocked = async (
  storage: Cloud,
  gameId: string,
  client: PoolClient,
) => {
  const started = performance.now()
  const { rows } = await client.query<{
    owner_epoch: number
    expired: boolean
    status: string
    current_position: number
    now: Date
  }>(
    `SELECT owner_epoch, lease_until <= clock_timestamp() AS expired, status, current_position,
       clock_timestamp() AS now FROM rooms WHERE id = $1 FOR UPDATE SKIP LOCKED`,
    [gameId],
  )

  const room = rows.at(0)

  if (!room || !room.expired || !["lobby", "running"].includes(room.status)) {
    return undefined
  }

  const token = randomUUID()
  const granted = await storage.redis.set(leaseKey(gameId), token, {
    condition: "NX",
    expiration: { type: "PX", value: roomLeaseTtlMs },
  })

  if (!granted) {
    return undefined
  }

  const lease = new RoomLease({
    gameId,
    token,
    epoch: room.owner_epoch + 1,
    deadline: started + roomLeaseTtlMs,
  })

  try {
    await client.query(
      "UPDATE rooms SET owner_token = $2, owner_epoch = $3, lease_until = $4 WHERE id = $1",
      [
        gameId,
        token,
        lease.epoch,
        new Date(room.now.getTime() + roomLeaseTtlMs),
      ],
    )
    await storage.redis
      .multi()
      .hSet(roomKey(gameId), {
        owner: storage.nodeId,
        phase: room.status,

        position: String(room.current_position),
        epoch: String(lease.epoch),
      })
      .pExpire(roomKey(gameId), roomLeaseTtlMs)
      .exec()

    if (!lease.active) {
      throw new LeaseLost(gameId)
    }

    return lease
  } catch (error) {
    await deleteRedisLease(storage, lease).catch(console.error)
    throw error
  }
}

export const acquireLease = async (storage: Cloud, gameId: string) => {
  const lease = await storage.transaction((client) =>
    acquireLocked(storage, gameId, client),
  )

  if (lease) {
    metrics.increment("leases_acquired")
  }

  return lease
}

export const renewLease = async (storage: Cloud, lease: RoomLease) => {
  const started = performance.now()
  await storage.transaction(async (client) => {
    await assertLease(client, lease)
    const {
      rows: [clock],
    } = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    const renewed = await storage.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('PEXPIRE', KEYS[1], ARGV[2])
         redis.call('HSET', KEYS[2], 'owner', ARGV[3], 'epoch', ARGV[4])
         redis.call('PEXPIRE', KEYS[2], ARGV[2])
         return 1
       end return 0`,
      {
        keys: [leaseKey(lease.gameId), roomKey(lease.gameId)],
        arguments: [
          lease.token,
          String(roomLeaseTtlMs),
          storage.nodeId,
          String(lease.epoch),
        ],
      },
    )

    if (renewed !== 1) {
      throw new LeaseLost(lease.gameId)
    }

    await client.query("UPDATE rooms SET lease_until = $2 WHERE id = $1", [
      lease.gameId,
      new Date(clock.now.getTime() + roomLeaseTtlMs),
    ])
  })
  lease.renew(started + roomLeaseTtlMs)

  if (!lease.active) {
    throw new LeaseLost(lease.gameId)
  }
}

export const releaseLease = async (storage: Cloud, lease: RoomLease) => {
  lease.invalidate()
  await storage.pool.query(
    "UPDATE rooms SET lease_until = clock_timestamp() WHERE id = $1 AND owner_token = $2 AND owner_epoch = $3",
    [lease.gameId, lease.token, lease.epoch],
  )
  await deleteRedisLease(storage, lease)
}
