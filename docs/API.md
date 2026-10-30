# API Reference (Phase 3)

Base URL: `http://localhost:5000/api`

All responses are JSON. Successful responses use `{ ok: true, data: ... }`.
Errors use `{ ok: false, code, message, details? }`. Internal errors and stack traces
are never returned.

## Conventions

| Item | Rule |
| --- | --- |
| Room code | 6 characters, `A-Z0-9`, case-insensitive on input |
| Name | 1–40 characters, trimmed |
| `userId` | Optional client id, 1–64 chars (`A-Z a-z 0-9 _ -`). Generated with `crypto.randomUUID()` when omitted |
| `videoId` | YouTube id, exactly 11 chars |
| Unknown body fields | Rejected with `400` |

## GET /api/health

Liveness + database status.

```bash
curl http://localhost:5000/api/health
```

```json
{
  "status": "ok",
  "service": "youtube-party-backend",
  "uptime": 12.345,
  "timestamp": "2026-10-29T19:20:12.733Z",
  "database": { "state": "connected", "name": "youtube_party" }
}
```

- `200` — server up. `status` is `ok` when the DB is connected, `degraded` otherwise.

## POST /api/rooms

Creates a room. The caller becomes the **host**.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `hostName` | string | yes | 1–40 chars |
| `hostId` | string | no | Client-supplied id; UUID generated if omitted |
| `videoId` | string \| null | no | 11-char YouTube id |

```bash
curl -X POST http://localhost:5000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"hostName":"Omkar","videoId":"dQw4w9WgXcQ"}'
```

PowerShell — write the JSON to a file first, then:

```powershell
curl.exe -X POST http://localhost:5000/api/rooms `
  -H "Content-Type: application/json" --data-binary "@body.json"
```

**201 Created**

```json
{
  "ok": true,
  "data": {
    "room": {
      "roomId": "6NFTFS",
      "videoId": "dQw4w9WgXcQ",
      "playbackStatus": "paused",
      "currentTime": 0,
      "playbackUpdatedAt": "2026-10-29T19:20:12.733Z",
      "hostId": "8218af8d-dfff-4bd3-ac27-36e15dd6d3ab",
      "participants": [
        {
          "userId": "8218af8d-dfff-4bd3-ac27-36e15dd6d3ab",
          "name": "Omkar",
          "role": "host",
          "connected": false,
          "joinedAt": "2026-10-29T19:20:12.733Z"
        }
      ],
      "lastActivityAt": "2026-10-29T19:20:12.733Z",
      "createdAt": "2026-10-29T19:20:12.746Z",
      "updatedAt": "2026-10-29T19:20:12.746Z",
      "id": "6ae39c6c7213ff182da3f73c"
    },
    "hostId": "8218af8d-dfff-4bd3-ac27-36e15dd6d3ab",
    "token": "eyJ2IjoxLCJ1c2VySWQiOiI4MjE4YWY4ZCIsInJvb21JZCI6IjZORlRGUyIsImlhdCI6MTc2MTc2ODYxMjczM30.3f9c..."
  }
}
```

`data.hostId` is the id the client must keep to act as host later.
`data.token` is the **signed socket identity** (see [SOCKET_EVENTS.md](./SOCKET_EVENTS.md)).
It is required to join the room over Socket.IO and is valid for 12 hours.

Errors: `400 validation_error`, `503 room_code_unavailable`.

## GET /api/rooms/:roomId

Returns the current room state. Codes are case-insensitive.

```bash
curl http://localhost:5000/api/rooms/6nftfs
```

**200 OK**

```json
{ "ok": true, "data": { "room": { "roomId": "6NFTFS", "...": "..." } } }
```

| Status | Code | When |
| --- | --- | --- |
| `400` | `validation_error` | `roomId` is not 6 letters/digits |
| `404` | `not_found` | Room does not exist |

## POST /api/rooms/:roomId/join

Adds a participant, or refreshes an existing one (idempotent).

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | 1–40 chars |
| `userId` | string | no | Pass the same id to rejoin/rename; otherwise generated |

```bash
curl -X POST http://localhost:5000/api/rooms/6NFTFS/join \
  -H "Content-Type: application/json" \
  -d '{"name":"Guest One"}'
```

**200 OK**

```json
{
  "ok": true,
  "data": {
    "room": { "roomId": "6NFTFS", "participants": ["..."] },
    "userId": "4321e844-01ba-4229-b4b7-09ba44e630a5",
    "joined": true,
    "token": "eyJ2IjoxLCJ1c2VySWQiOiI0MzIxZTg0NCIsInJvb21JZCI6IjZORlRGUyIsImlhdCI6MTc2MTc2ODYxNDU5N30.7c1a..."
  }
}
```

- `joined: true` — new participant added.
- `joined: false` — the `userId` already existed; name/connected were refreshed.
- `token` — signed socket identity for this room (12 h TTL).

| Status | Code | When |
| --- | --- | --- |
| `400` | `validation_error` | Missing/invalid `name`, `userId` or `roomId` |
| `404` | `not_found` | Room does not exist |
| `409` | `room_full` | Room already has 20 participants |
| `409` | `participant_conflict` | Concurrent join race — retry |

## Error envelope

```json
{
  "ok": false,
  "code": "validation_error",
  "message": "Request validation failed",
  "details": [{ "field": "roomId", "message": "roomId must be exactly 6 letters or digits" }]
}
```

| Code | Status | Meaning |
| --- | --- | --- |
| `validation_error` | 400 | Body/param failed validation (`details` says which field) |
| `invalid_json` | 400 | Malformed JSON body |
| `payload_too_large` | 413 | Body over 100 kB |
| `invalid_parameter` | 400 | Wrong value type reached the database layer |
| `not_found` | 404 | Route or room not found |
| `room_full` | 409 | 20 participant limit reached |
| `participant_conflict` | 409 | Duplicate participant race |
| `conflict` | 409 | Unique index violation |
| `room_code_unavailable` | 503 | Could not allocate a unique code |
| `internal_error` | 500 | Unexpected failure — details only in server logs |

## Room codes

- Generated with `crypto.randomInt` from a 32-character alphabet
  (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `0/O/1/I/L`).
- `32^6 ≈ 1.07 billion` combinations.
- The unique index on `roomId` is the real guard; creation retries up to 8 times on
  a duplicate-key error before returning `503 room_code_unavailable`.

## Not implemented yet

- Socket.IO events (`join_room`, sync, chat)
- Role management (promote/demote, host transfer)
- Authentication — `hostId` / `userId` are self-declared client ids
