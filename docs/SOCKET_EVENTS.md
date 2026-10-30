# Socket Events (Phase 4 Presence & Phase 6 Playback Sync)

Socket.IO server runs on the **same HTTP server and port** as the REST API
(`http://localhost:5000`), default path `/socket.io`.

| Item | Value |
| --- | --- |
| Client package | `socket.io-client` |
| Transports | `websocket`, `polling` |
| Allowed origins | `CLIENT_ORIGIN` (comma-separated) — enforced for REST CORS **and** the socket handshake (`allowRequest`, so raw WebSocket clients are checked too) |
| Max message size | `SOCKET_MAX_BUFFER_BYTES` (default 100 kB) |
| Server client bundle | Disabled (`serveClient: false`) |

> **Scope:** joining/leaving presence (Phase 4) and authoritative playback synchronization (Phase 6).
> Video playback is synchronized across all participants within <300 ms drift.

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

## Playback Synchronization (Phase 6)

Authoritative real-time video synchronization between all participants in a room.

### Architecture & Clock Synchronization
1. **Clock Estimation (`clock_ping`)**:
   Clients periodically ping the server with `clock_ping`. By measuring minimum round-trip time (`rtt`), the client estimates its clock offset against the server:
   $$\text{offset} = \text{serverTime} - \frac{\text{sentAt} + \text{receivedAt}}{2}$$
2. **Scheduled Apply Window (`executeAt`)**:
   When a playback command is issued, the server bumps `seq`, records `updatedAt = Date.now()`, and broadcasts with:
   $$\text{executeAt} = \text{serverTime} + 250\text{ ms}$$
   All clients schedule execution at `executeAt - serverNow()`, eliminating network transit jitter.
3. **Late-Joiner Compensation**:
   When a user connects, the server calculates:
   $$\text{elapsed} = \max(0, (\text{now} - \text{playbackUpdatedAt}) / 1000)$$
   $$\text{position} = \text{currentTime} + \text{elapsed}$$
   The late joiner immediately seeks to the current video position without manual scrubbing.
4. **3-Tier Drift Correction (Heartbeat every 3s)**:
   * **Tier 1 (<150 ms)**: Ignored (imperceptible to human ear/eye).
   * **Tier 2 (150 ms – 900 ms)**: Smooth adjustment: player speed is nudged to `1.05x` or `0.95x` for up to 4s to catch up without audio pitch distortion or frame freezing.
   * **Tier 3 (>900 ms)**: Hard seek to the authoritative position.

### Playback Client → Server Events

#### `clock_ping`
Requests the authoritative server timestamp for RTT clock estimation.
```ts
socket.emit('clock_ping', {}, (ack) => {
  // ack.data.serverTime
})
```

#### `playback_request_state`
Requests the current authoritative snapshot (used during initial mount or reconnection).
```ts
socket.emit('playback_request_state', {}, (ack) => {})
```

#### `playback_play`
Starts playback at the specified position.
```ts
socket.emit('playback_play', { position: 42.5 }, (ack) => {})
```

#### `playback_pause`
Pauses playback at the specified position.
```ts
socket.emit('playback_pause', { position: 42.5 }, (ack) => {})
```

#### `playback_seek`
Seeks playback to the specified position.
```ts
socket.emit('playback_seek', { position: 120.0 }, (ack) => {})
```

#### `playback_ended`
Notifies that the video finished playing.
```ts
socket.emit('playback_ended', { position: 240.0 }, (ack) => {})
```

#### `playback_change_video`
Loads a new YouTube video id in the room and resets position to `0`.
```ts
socket.emit('playback_change_video', { videoId: 'aqz-KE-bpKQ' }, (ack) => {})
```

#### `playback_grant_control`
Host transfers playback controller rights to another participant, or reclaims it.
```ts
socket.emit('playback_grant_control', { userId: 'target-user-id' }, (ack) => {})
```

### Playback Server → Client Broadcasts

#### `playback_state`
Emitted to `room:<roomId>` on every playback mutation, join snapshot, and 3-second heartbeat.
```json
{
  "roomId": "6NFTFS",
  "videoId": "aqz-KE-bpKQ",
  "status": "playing",
  "position": 42.5,
  "seq": 4,
  "serverTime": 1761800000000,
  "updatedAt": 1761800000000,
  "controllerId": "8218af8d-...",
  "executeAt": 1761800000250,
  "heartbeat": false,
  "snapshot": false
}
```

| Field | Type | Description |
| --- | --- | --- |
| `roomId` | string | Target room identifier |
| `videoId` | string \| null | Current YouTube 11-char video ID |
| `status` | `'paused' \| 'playing' \| 'ended'` | Authoritative playback status |
| `position` | number | Position in seconds at `updatedAt` |
| `seq` | number | Strictly increasing sequence number (stale packets with lower seq are dropped) |
| `serverTime` | number | Server epoch millisecond when packet was generated |
| `updatedAt` | number | Server epoch millisecond when position anchor was saved |
| `controllerId` | string | User ID authorized to control playback |
| `executeAt` | number | Scheduled execution epoch timestamp |
| `heartbeat` | boolean? | `true` if broadcast originated from the 3-second periodic timer |
| `snapshot` | boolean? | `true` if sent as a snapshot to a connecting/reconnecting socket |

#### `control_changed`
Emitted when playback control is transferred:
```json
{
  "roomId": "6NFTFS",
  "controllerId": "target-user-id",
  "hostId": "host-user-id"
}
```

---

## Phase 7 — Roles & Permissions Events

Three distinct roles: `host`, `moderator`, and `participant`.
- Room creator automatically becomes `host`.
- New members automatically become `participant`.
- `host` and `moderator` can control video playback (`playback_play`, `playback_pause`, `playback_seek`, `playback_change_video`).
- `participant` cannot directly control playback (commands rejected with `{ ok: false, code: "forbidden" }`).
- Only `host` can assign or revoke `moderator` privileges.
- Only `host` can remove participants.

### Client → Server Events

#### `assign_role`
Only the **host** can promote or demote participants between `moderator` and `participant`.
```ts
socket.emit('assign_role', { userId: 'target-user-id', role: 'moderator' }, (ack) => {})
```
* **Forbidden if:** caller is not the host, or target is the host.
* **Ack:** `{ ok: true, data: { userId, role, participants } }`

#### `transfer_host`
The **host** transfers full room ownership to another participant. The previous host becomes a `moderator`.
```ts
socket.emit('transfer_host', { userId: 'target-user-id' }, (ack) => {})
```
* **Forbidden if:** caller is not the host, or target is self.
* **Ack:** `{ ok: true, data: { hostId, participants } }`

#### `remove_participant`
Only the **host** can remove participants from the room.
```ts
socket.emit('remove_participant', { userId: 'target-user-id' }, (ack) => {})
```
* **Forbidden if:** caller is not the host, or target is self/host.
* **Ack:** `{ ok: true, data: { userId, removed: true, participants } }`

### Server → Client Broadcasts

#### `role_assigned`
Emitted when a participant's role is updated.
```json
{
  "roomId": "6NFTFS",
  "userId": "target-user-id",
  "role": "moderator",
  "participants": ["..."]
}
```

#### `host_transferred`
Emitted when host ownership changes (manual transfer or disconnect fallback).
```json
{
  "roomId": "6NFTFS",
  "previousHostId": "old-host-id",
  "newHostId": "new-host-id",
  "participants": ["..."],
  "fallback": false
}
```

#### `kicked`
Emitted directly to the disconnected sockets of an evicted participant.
```json
{
  "roomId": "6NFTFS",
  "reason": "You were removed from the room by the host."
}
```

---

## Not implemented yet

- Chat / reactions (Phase 9)
- Debounced persistence & room lifecycle (Phase 8)
- Rate limiting per socket
