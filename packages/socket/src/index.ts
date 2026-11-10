import { createAdaptorServer } from "@hono/node-server"
import { app, createSocketServer } from "@razzia/socket/app"
import { importFileQuizzes } from "@razzia/socket/services/catalog"
import { cloud } from "@razzia/socket/services/cloud"
import { initConfig } from "@razzia/socket/services/config"
import {
  RoomCoordinator,
  setCoordinator,
} from "@razzia/socket/services/coordinator"
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
  const coordinator = cloud && new RoomCoordinator(cloud, io)

  if (coordinator) {
    setCoordinator(coordinator)
    await coordinator.start()
  }

  server.listen(WS_PORT, () => console.log(`Server running on port ${WS_PORT}`))

  const shutdown = async () => {
    if (coordinator) {
      await coordinator.stop()
    } else {
      Registry.getInstance().cleanup()
    }

    await io.close()
    await cloud?.close()
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
