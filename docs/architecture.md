# Architecture (target design)

> Phase 1–5 are implemented: Express API + MongoDB + room REST APIs + Socket.IO presence
> + local YouTube player. Playback synchronization is planned (Phase 6).

## High level

```
┌──────────────────────────┐        ┌───────────────────────────┐        ┌──────────────┐
│ frontend/  React + Vite  │  REST  │ backend/  Express         │        │  MongoDB     │
│                          │◄──────►│                           │◄──────►│  done ✅     │
│  pages/       routes     │        │  routes/ → controllers/   │        └──────────────┘
│  components/  UI         │  WS    │  sockets/  presence ✅    │
│  hooks/       state      │◄──────►│  services/ room + sync    │
│  services/    REST calls │        │  models/   Room ✅        │
│  socket/      IO client  │        │  config/   env + db ✅    │
│  utils/       helpers    │        │  middleware/ errors ✅    │
└──────────────────────────┘        └───────────────────────────┘
```

## Responsibilities

| Path | Responsibility |
| --- | --- |
| `frontend/src/pages` | One component per route (`/`, `/room/:roomCode`, 404) |
| `frontend/src/components` | Reusable UI (header, participant list, room view, YouTube player) |
| `frontend/src/hooks` | Reusable stateful logic (`usePageTitle`, `useRoom` socket lifecycle) |
| `frontend/src/services` | HTTP layer; the only place that knows about URLs |
| `frontend/src/socket` | Typed Socket.IO client (`socket.ts`) |
| `frontend/src/utils` | Pure helpers with no React dependency |
| `backend/src/routes` | URL → controller mapping only |
| `backend/src/controllers` | Parse request, call a service, shape the response |
| `backend/src/services` | Domain logic; no Express objects here (`room.service.js`) |
| `backend/src/models` | Mongoose schemas (`Room`) |
| `backend/src/sockets` | Socket.IO presence layer (`watchParty.socket.js`) |
| `backend/src/middleware` | Validation, 404 and centralized error handling |
| `backend/src/config` | Environment parsing (`env.js`) and DB connection (`db.js`) |
| `backend/src/utils` | Errors, async wrapper, room codes, tokens, zod schemas, logger |

## Startup sequence

1. `src/index.js` loads `env.js` (which loads `.env`).
2. `assertRuntimeConfig()` refuses unsafe production settings (no `SESSION_SECRET`,
   wildcard `CLIENT_ORIGIN`).
3. `connectDB()` connects to MongoDB; on failure the process logs a redacted,
   actionable error and exits with code `1`.
4. Only then does Express call `listen()`.
5. `initWatchPartySocket(server)` attaches Socket.IO to the same HTTP server.
6. `GET /api/health` reports the live Mongoose connection state.
7. `SIGINT` / `SIGTERM` closes Socket.IO, the HTTP server, then MongoDB.

## Data model

```
Room
├── roomId            unique 6-char code (A-Z0-9)
├── videoId           YouTube id or null
├── playbackStatus    paused | playing | ended
├── currentTime       seconds >= 0
├── playbackUpdatedAt server timestamp for currentTime
├── hostId            userId of the host
├── participants[]    { userId, name, role, socketId, connected, joinedAt }
├── lastActivityAt    for idle-room cleanup
└── createdAt / updatedAt
```

Rules: max 20 participants, unique `userId` per room, exactly one participant with
role `host`, and `hostId` must match it. `socketId` is server-internal and never
leaves the API or the socket layer.

## Identity

```
REST create/join  ->  signed token (userId + roomId + iat, HMAC-SHA256)
socket join_room  ->  verify signature + expiry + room match
                  ->  load participant from MongoDB (role comes from the DB)
```

The token contains **no role**. A client-supplied `role` or `socketId` is ignored.
See [SOCKET_EVENTS.md](./SOCKET_EVENTS.md).

## Realtime presence (Phase 4)

1. Client connects; no room is joined yet.
2. `join_room { roomId, token }` → payload validated → token verified → participant
   looked up in MongoDB.
3. Presence registry `roomId -> userId -> Set<socketId>` is updated; DB records
   `connected: true` and the internal `socketId`.
4. Joining socket gets `room_state`; others get `participant_joined`
   (or `participant_updated` for an additional tab).
5. Last socket disconnecting keeps the seat (`connected: false`) and broadcasts
   `participant_left` with `removed: false`.
6. An explicit `leave_room` deletes a non-host participant (seat freed,
   `removed: true`); the host seat is only marked offline until role transfer
   exists. The React `useRoom()` hook owns this lifecycle, including rejoin and
   token refresh after reconnects.

## Local player (Phase 5)

`VideoPlayer.jsx` does not build iframe HTML: ids pass `isValidYouTubeVideoId()`
(`^[A-Za-z0-9_-]{11}$`) and the official IFrame API creates the embed on
`youtube-nocookie.com`. The API script is injected once by
`utils/youtubeIframe.ts` and shared through a single promise.

- React renders the overlays; the player owns its own dedicated mount node
  (sharing one container makes React's `removeChild` fail).
- Custom controls call `playVideo` / `pauseVideo` / `seekTo`; a 250 ms ticker
  reports `currentTime` and `duration`.
- `play()` / `pause()` / `seekTo()` are exposed through a ref for Phase 6.
- Unmount stops the ticker, calls `player.destroy()` and removes the iframe.

Details, error codes and browser restrictions: [PLAYER.md](./PLAYER.md).

## Planned sync flow (next phase)

1. Client sends a control event with its local timestamp.
2. Server validates permissions, computes `executeAt = serverNow + 250ms`, bumps `seq`.
3. Server persists `playbackStatus` / `currentTime` / `playbackUpdatedAt` (debounced),
   then broadcasts the state.
4. Clients ignore stale `seq`, convert server time using their measured clock offset,
   and apply the action at `executeAt`.
5. A 3-second heartbeat plus drift control keeps every player within ~300 ms.
