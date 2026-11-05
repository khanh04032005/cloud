import { createAdaptorServer } from "@hono/node-server"
import { app, createSocketServer } from "@razzia/socket/app"
import { importFileQuizzes } from "@razzia/socket/services/catalog"
import { cloud } from "@razzia/socket/services/cloud"
import { initConfig } from "@razzia/socket/services/config"
import Registry from "@razzia/socket/services/registry"

const WS_PORT = Number(process.env.SOCKET_PORT) || 3001

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason)
})

const start = async () => {
  initConfig()
  await cloud?.connect()
  await importFileQuizzes()

  const server = createAdaptorServer({ fetch: app.fetch })
  const io = createSocketServer(server)
  server.listen(WS_PORT, () => console.log(`Server running on port ${WS_PORT}`))

  const shutdown = async () => {
    const registry = Registry.getInstance()
    const games = registry.getAllGames()
    registry.cleanup()
    await io.close()
    const storage = cloud

    if (storage) {
      const outcomes = await Promise.allSettled(
        games.map((game) => storage.removeRoom(game.gameId)),
      )
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          console.error("Could not close room:", outcome.reason)
        }
      }
      await storage.close()
    }
  }
  const stop = () => {
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Shutdown failed:", error)
        process.exit(1)
      },
    )
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

void start().catch((error: unknown) => {
  console.error("Socket startup failed:", error)
  process.exit(1)
})
