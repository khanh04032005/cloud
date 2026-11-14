# 📚 Documentation

This folder covers the basic setup (config, quizzes, branding) as well as more advanced usage, like running behind a reverse proxy or building your own client.

- [Configuration](configuration.md): environment variables and the `config` folder.
- [Quiz](quiz.md): creating and structuring quizzes via `config/quizz/*.json`.
- [Branding](branding.md): optional custom theming via `config/branding/`.
- [Reverse Proxy](reverse-proxy.md): running Razzia behind Traefik, Nginx, Caddy, or another reverse proxy.
- [WebSocket Protocol](websocket-protocol.md): the player-facing event protocol, for building custom clients (e.g. a physical buzzer).
- [HTTP API](http-api.md): the `/api` surface — sessions, quiz and result CRUD, game creation.
- [Testing](testing.md): running and writing the unit, integration and e2e tests.
- The [Live Quiz week 1–2 handoff](live-quiz-week-1-2.md) covers the game event flow, PostgreSQL migration, and contracts for streaming and split deployment.
- The [week 4 backend handoff](live-quiz-week-4.md) covers answer transactions, the score worker contract, database reconnect and final reports.

- The [week 5 backend handoff](live-quiz-week-5.md) covers fenced room leases, engine recovery, health and metrics.
- The [final Person A handoff](live-quiz-person-a-handoff.md) records the final fixes, report chapters, verification evidence and integration/demo steps.

Back to the [main README](../README.md).
