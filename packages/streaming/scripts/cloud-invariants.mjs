import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const root = resolve(import.meta.dirname, "../../..")
const scratch = await mkdtemp(join(tmpdir(), "razzia-cloud-tests-"))
const containers = []
const servers = []
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
const freePort = async () => {
  const server = createServer()
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}
const ports = []
let passed = false
try {
  console.log("Starting disposable PostgreSQL/Redis for backend invariants")
  const postgres = docker(
    "run",
    "--rm",
    "-d",
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_PASSWORD=cloud-test",
    "-e",
    "POSTGRES_DB=razzia",
    "postgres:16-alpine",
  )
  containers.push(postgres)
  const redis = docker(
    "run",
    "--rm",
    "-d",
    "-p",
    "127.0.0.1::6379",
    "redis:7-alpine",
  )
  containers.push(redis)
  const dbPort = docker("port", postgres, "5432/tcp").split(":").at(-1)
  const redisPort = docker("port", redis, "6379/tcp").split(":").at(-1)
  const database = `postgres://postgres:cloud-test@127.0.0.1:${dbPort}/razzia`
  const cache = `redis://127.0.0.1:${redisPort}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(
        "exec",
        "-e",
        "PGPASSWORD=cloud-test",
        postgres,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "razzia",
        "-qtAc",
        "SELECT 1",
      )
      ready = true
      break
    } catch {
      await delay(250)
    }
  }
  if (!ready) {
    throw new Error("PostgreSQL did not become ready")
  }
  const migrationDir = join(root, "packages/socket/migrations")
  for (const filename of (await readdir(migrationDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        postgres,
        "psql",
        "-U",
        "postgres",
        "-d",
        "razzia",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        input: await readFile(join(migrationDir, filename)),
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
  }
  for (let index = 0; index < 2; index += 1) {
    const port = await freePort()
    ports.push(port)
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: join(root, "packages/socket"),
      env: {
        ...process.env,
        DATABASE_URL: database,
        REDIS_URL: cache,
        SOCKET_PORT: String(port),
        CONFIG_PATH: join(scratch, `config-${index}`),
        MANAGER_PASSWORD: "test-password",
        JWT_SECRET: "week4-test-shared-secret-at-least-32-characters",
        GAME_SPEED: "5",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const record = { child, logs: "" }
    servers.push(record)
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        record.logs = `${record.logs}${chunk.toString()}`.slice(-50000)
      })
    }
    let healthy = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(record.logs)
      }
      try {
        healthy = (
          await fetch(`http://127.0.0.1:${port}/health/ready`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      } catch {
        healthy = false
      }
      if (healthy) {
        break
      }
      await delay(200)
    }
    if (!healthy) {
      throw new Error(`Backend ${port} did not become ready: ${record.logs}`)
    }
  }
  const env = {
    ...process.env,
    CLOUD_TEST_DATABASE_URL: database,
    CLOUD_TEST_REDIS_URL: cache,
    CLOUD_TEST_A: `http://127.0.0.1:${ports[0]}`,
    CLOUD_TEST_B: `http://127.0.0.1:${ports[1]}`,
    CLOUD_TEST_MANAGER_PASSWORD: "test-password",
  }
  delete env.DATABASE_URL
  delete env.REDIS_URL
  console.log(
    "Running backend invariants with real PostgreSQL, Redis and two gateways",
  )
  const args = [
    "exec",
    "vitest",
    "run",
    "--project",
    "socket",
    // Each file owns fixtures in the same database; keep load isolated between files.
    "--no-file-parallelism",
    "packages/socket/src/test/answers.test.ts",
    "packages/socket/src/test/cloud.test.ts",
    "packages/socket/src/test/failover.test.ts",
    "packages/socket/src/test/room-state.test.ts",
    "packages/socket/src/test/room-policy.test.ts",
    ...process.argv.slice(2).filter((arg) => arg !== "--"),
  ]
  const tests = spawn("pnpm", args, { cwd: root, env, stdio: "inherit" })
  const code = await new Promise((done, reject) => {
    tests.once("error", reject)
    tests.once("exit", done)
  })
  if (code !== 0) {
    throw new Error(`Backend invariant tests failed (exit ${code})`)
  }
  passed = true
} finally {
  for (const { child, logs } of servers) {
    if (!passed) {
      console.error(logs)
    }
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done))
      child.kill("SIGTERM")
      await Promise.race([exited, delay(1500)])
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await exited
      }
    }
  }
  for (const container of containers.reverse()) {
    try {
      docker("stop", "--time", "2", container)
    } catch (error) {
      console.error("Test container cleanup failed", error.message)
    }
  }
  await rm(scratch, { recursive: true, force: true })
}
