# Configuration

Razzia is configured in two places:

- **Environment variables** for the manager password and the session secret.
- The **`config` folder** for content: quizzes, results and branding. It is mounted as a Docker volume, or resolved as `../../config` relative to the packages when running without Docker.

## Environment variables

Copy [`.env.example`](../.env.example) to `.env` at the root of the project:

```bash
MANAGER_PASSWORD=your-password
JWT_SECRET=
```

| Variable            | Required | What it does                                                                                                           |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MANAGER_PASSWORD`  | Yes      | Unlocks the manager interface. Until it is set, manager access is refused with `errors:manager.passwordNotConfigured`. |
| `JWT_SECRET`        | Cloud    | Signs session tokens. An explicit secret must be at least 32 characters.                                               |
| `WEB_PORT`          | No       | Without Docker only: port the app is served on. Defaults to `3000`.                                                    |
| `SOCKET_PORT`       | No       | Without Docker only: port of the socket server, proxied behind the web port. Defaults to `3001`.                       |
| `DATABASE_URL`      | Cloud    | PostgreSQL connection URL for the quiz catalog and persistent room state.                                              |
| `ROOM_LEASE_TTL_MS` | No       | Room lease duration in milliseconds, minimum 1000; default 9000.                                                       |
| `REDIS_URL`         | Cloud    | Redis connection URL for active room routing, phase and Socket.IO events.                                              |

`pnpm dev` and `pnpm start` load `.env` automatically. With Docker, `compose.yml` reads the same file through `env_file`, or you can set the variables inline with `environment:`. With a bare `docker run`, pass them with `-e MANAGER_PASSWORD=...`.

### About `JWT_SECRET`

Leave it empty and the server generates a new secret at every start. The consequence is that a restart logs every manager out and hands every player a fresh identity.

For a standalone server, an explicit secret lets existing session tokens survive a restart. Cloud mode requires the same secret on every socket replica. Keep it private because it can be used to sign manager sessions.

Generate one with either of these:

```bash
openssl rand -hex 32

# No openssl? Node is already a prerequisite:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Both print 64 hexadecimal characters, the same shape the server generates for itself.

## Shared room state

Apply the migrations below in order on a new database. Apply each migration once. For an existing database, apply only the migrations that have not been run.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/socket/migrations/001_live_quiz.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/socket/migrations/002_shared_room_state.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/socket/migrations/003_durable_answers.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/socket/migrations/004_room_leases.sql
```

Set both connection URLs and a shared `JWT_SECRET` on every socket replica. Start the first replica with the existing `config/quizz/` directory mounted if you want to import existing quizzes. Startup imports that directory into PostgreSQL once per database and preserves quiz IDs. Subsequent quiz edits use PostgreSQL. Standalone mode uses the file catalog when both URLs are empty.

In cloud mode PostgreSQL holds the quiz catalog, rooms, player membership and round snapshots. Redis holds the active room's coordinator and current round phase and carries Socket.IO messages between replicas. Route `/api` and `/ws` to the socket service. The socket gateway accepts the WebSocket transport and `/health/ready` checks PostgreSQL and Redis connectivity.

Each room's coordinator runs the Razzia engine and its timers. Cloud answers and their outbox events are committed together. The backend reads scores written by B's worker and waits for all accepted answers before showing round results. Player reconnect and new result reports use PostgreSQL. A Redis lease with PostgreSQL fencing allows another replica to restore the engine and persisted timer deadlines after the coordinator exits. Graceful shutdown releases ownership without cancelling active rooms. See the [week 5 handoff](live-quiz-week-5.md). The [week 4 handoff](live-quiz-week-4.md) describes the worker contract and reconnect behavior. Legacy result files remain available from their original directory.

## The `config` folder

Created automatically on first run, with an example quiz:

```
config/
  quizz/      your quizzes
  results/    saved game results
  media/      files uploaded from the quiz editor
  branding/   optional theming
```

See [Quiz Configuration](quiz.md) and [Custom Branding](branding.md).
