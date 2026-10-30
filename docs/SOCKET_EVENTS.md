# Socket Events (Phase 4)

Socket.IO server runs on the **same HTTP server and port** as the REST API
(`http://localhost:5000`), default path `/socket.io`.

| Item | Value |
| --- | --- |
| Client package | `socket.io-client` |
| Transports | `websocket`, `polling` |
| Allowed origins | `CLIENT_ORIGIN` (comma-separated) — enforced for REST CORS **and** the socket handshake (`allowRequest`, so raw WebSocket clients are checked too) |
| Max message size | `SOCKET_MAX_BUFFER_BYTES` (default 100 kB) |
| Server client bundle | Disabled (`serveClient: false`) |

> **Phase 4 scope:** joining/leaving presence only. No playback sync events yet —
> the room video plays locally per participant ([PLAYER.md](./PLAYER.md)); sync
> events arrive in Phase 6.

---

## Identity: signed participant tokens

A socket is **not** trusted to say who it is. Identity comes from a token issued by
the REST API:

```
POST /api/rooms           -> data.token   (host)
POST /api/rooms/:id/join  -> data.token   (participant)
```

Token format: `base64url(payload).hmacSha256(payload)`

```json
{ "v": 1, "userId": "8218af8d-...", "roomId": "6NFTFS", "iat": 1761768612733 }
```

- Signed with `SESSION_SECRET` (HMAC-SHA256, timing-safe comparison).
- Valid for `PARTICIPANT_TOKEN_TTL_MS` (default 12 h).
- Binds **one userId to one room** — a token for room A is rejected in room B.
- **No role inside the token.** Roles are always read from MongoDB, so a client
  cannot promote itself by editing the payload.
- `socketId` is never accepted from the client and never returned to any client.

### Secret policy

| Environment | No `SESSION_SECRET` |
| --- | --- |
| development | random per-process secret + warning; tokens die on restart |
| production | **server refuses to boot** (`assertRuntimeConfig()`) |

Production also refuses `CLIENT_ORIGIN=*`.

---

## Client → server

### `join_room`

```ts
socket.emit('join_room', { roomId: '6NFTFS', token }, (result) => {})
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `roomId` | string | yes | 6 letters/digits, case-insensitive |
| `token` | string | yes | Participant token from REST |

**Ack (success)**

```json
{
  "ok": true,
  "data": {
    "room": { "roomId": "6NFTFS", "participants": ["..."] },
    "self": { "userId": "8218af8d-...", "role": "host" }
  }
}
```

Also emits `room_state` to the joining socket with the same payload.

**Ack (failure)** — `{ ok: false, code, message }`

| Code | When |
| --- | --- |
| `validation_error` | `roomId` is not 6 letters/digits |
| `invalid_token` | Missing, tampered, expired, or minted for another room |
| `room_not_found` | Room does not exist |
| `not_a_participant` | Token's user is not in the room (e.g. removed) |
| `already_in_room` | This socket already joined a room |
| `internal_error` | Unexpected server failure |

### `leave_room`

```ts
socket.emit('leave_room', {}, (result) => {})
```

**Ack:** `{ ok: true, data: { roomId } }` · error `not_in_room` if the socket is idle.

---

## Server → client

| Event | Payload | When |
| --- | --- | --- |
| `room_state` | `{ room, self }` | Sent to the socket that just joined |
| `participant_joined` | `{ roomId, participant, participants }` | First socket of a user joins |
| `participant_updated` | `{ roomId, participants }` | Same user opens another tab |
| `participant_left` | `{ roomId, userId, username, removed, participants }` | Last socket closed, or an explicit `leave_room` |

`participant` / `participants` never contain `socketId`. `removed: true` means the
participant was deleted from the room (explicit leave); `removed: false` means the
seat is kept but `connected` is now `false` (dropped connection or host leave).

---

## Presence lifecycle

```
socket connects            -> nothing (no room yet)
join_room (valid token)    -> DB: connected=true, socketId=<internal>
                           -> self: room_state
                           -> others: participant_joined
second tab joins           -> others: participant_updated (no duplicate join event)
tab closes (still 1)       -> no broadcast, DB stays connected=true
last socket drops          -> DB: connected=false, socketId=null  (seat kept)
                           -> others: participant_left (removed=false)
leave_room (guest)         -> participant removed, seat freed
                           -> others: participant_left (removed=true)
leave_room (host)          -> host stays in the room as connected=false
                           -> others: participant_left (removed=false)
```

Presence is tracked in an in-memory registry (`roomId -> userId -> Set<socketId>`).
It is per-process: running multiple instances would need the Socket.IO Redis adapter.

---

## Frontend client

`frontend/src/socket/socket.ts` creates the client; `frontend/src/hooks/useRoom.ts`
owns the full lifecycle (connect → join → events → reconnect → token refresh).

The client always targets the backend origin from `VITE_SOCKET_URL`
(`http://localhost:5000`), never the Vite dev origin. `path` is explicitly
`/socket.io` (the server default). If the WebSocket upgrade is blocked, the client
falls back to long-polling (`tryAllTransports: true`).

```ts
const { room, self, status, error, retry, leave } = useRoom({
  roomId,
  userId: identity.userId,
  name: identity.name,
  token: identity.token,
})
```

Under the hood:

```ts
import { acquireWatchPartySocket, releaseWatchPartySocket } from '../socket/socket'

const socket = acquireWatchPartySocket() // autoConnect: false, one per tab
socket.on('connect', () => {
  socket.emit('join_room', { roomId, token }, (result) => {
    if (!result.ok) console.error(result.code, result.message)
  })
})
socket.on('participant_left', ({ participants }) => { /* ... */ })
socket.connect()
// on unmount:
releaseWatchPartySocket()
```

`acquireWatchPartySocket()` returns a single shared instance (React StrictMode and
fast route changes reuse it, so no duplicate connections).
`releaseWatchPartySocket()` defers the disconnect by one task so an immediate
remount does not abort the WebSocket handshake.

On every `connect` (including reconnects) the hook re-emits `join_room`. If the
server answers `invalid_token` / `not_a_participant`, it refreshes the token
through `POST /api/rooms/:roomId/join` and retries once.

Vite still proxies `/socket.io` when `VITE_SOCKET_URL` is empty, but the direct
backend URL is the supported default and avoids the proxy entirely. The backend
must list the frontend origin in `CLIENT_ORIGIN` (default
`http://localhost:5173`) — it is enforced for REST CORS and the socket handshake.

---

## Verify two clients

**Automated (no server, no Atlas):**

```bash
cd backend
npm test
```

The socket suite starts two real clients against a temporary MongoDB and asserts
join/leave broadcasts, explicit-leave seat removal, host-seat retention, token
rejection, spoofed-role rejection and multi-tab presence.

**Manual against a running server:**

```bash
cd backend
npm run dev            # terminal 1
npm run smoke:socket   # terminal 2
```

Expected:

```
PASS  REST create room — HTTP 201
PASS  REST returns a participant token
PASS  REST join room — HTTP 200
PASS  host socket joined — room_state received
PASS  host role is server-assigned
PASS  guest socket joined
PASS  host received participant_joined
PASS  client-supplied role was ignored
PASS  host received participant_left
PASS  guest marked disconnected in MongoDB
10/10 checks passed
```

The smoke script deletes the room it created. It uses only the public API — no
development backdoor is enabled in production.

---

## Not implemented yet

- Playback sync events (`play`, `pause`, `seek`, `change_video`, `sync_state`)
- Role management (`assign_role`, `transfer_host`)
- Chat / reactions
- Rate limiting per socket (planned for the quality phase)
