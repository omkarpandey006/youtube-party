# Docs

Architecture, database, API and realtime notes for the YouTube Party project.

| File | Contents |
| --- | --- |
| [architecture.md](./architecture.md) | High-level design, startup sequence, data flow |
| [database.md](./database.md) | MongoDB connection, `Room` schema, Atlas setup, troubleshooting |
| [API.md](./API.md) | REST endpoints, request/response examples, status codes, error codes |
| [PLAYER.md](./PLAYER.md) | YouTube player component, states, error codes, browser restrictions |
| [SOCKET_EVENTS.md](./SOCKET_EVENTS.md) | Socket.IO events, signed identity, presence lifecycle, smoke tests |

## Phase status

- Phase 1 — project setup ✅
- Phase 2 — MongoDB database setup ✅
- Phase 3 — backend room APIs ✅
- Phase 4 — Socket.IO realtime server ✅ · room UI ✅
- Phase 5 — YouTube player integration ✅ (local only; sync is Phase 6)

See [TASKS.md](../TASKS.md) for the full roadmap.
