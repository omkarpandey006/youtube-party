# Database — MongoDB + Mongoose

> **Status:** connection layer and `Room` model are implemented and verified against a
> real `mongod` (in-memory instance). Your **Atlas** cluster has **not** been tested yet,
> because no credentials were available in `backend/.env`.

## 1. How the connection works

| Piece | File | Responsibility |
| --- | --- | --- |
| Config | `backend/src/config/env.js` | Reads `MONGODB_URI`, `MONGODB_DB`, timeouts |
| Connection | `backend/src/config/db.js` | `connectDB()`, `disconnectDB()`, `getDatabaseStatus()` |
| Startup | `backend/src/index.js` | Connects **before** `listen()`; exits with a clear message on failure |
| Health | `GET /api/health` | Returns `database.state` (`connected`, `connecting`, `disconnected`) |

Key behaviours:

- **Fail fast.** If MongoDB is unreachable the process exits with code `1` instead of
  serving a half-broken API.
- **No credential leaks.** Errors and logs print the URI with the username and password
  replaced by `***`.
- **Actionable errors.** Authentication failures, DNS problems, refused connections,
  Atlas IP whitelist problems and timeouts each get their own hint.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` closes the HTTP server, then the DB connection.
- **Pooling.** `maxPoolSize: 10`, 10 s server selection timeout (configurable).

## 2. `Room` model

File: `backend/src/models/Room.js`

| Field | Type | Rules / default |
| --- | --- | --- |
| `roomId` | `String` | **required**, unique, 6 chars `A-Z0-9`, uppercased, trimmed |
| `videoId` | `String \| null` | default `null`; must be an 11-char YouTube id |
| `playbackStatus` | `String` | enum `paused` \| `playing` \| `ended`, default `paused` |
| `currentTime` | `Number` | default `0`, cannot be negative, must be finite |
| `playbackUpdatedAt` | `Date` | server timestamp for `currentTime` (sync compensation) |
| `hostId` | `String` | **required**, max 64 chars, must match the participant with role `host` |
| `participants[]` | subdocument[] | `userId`, `name`, `role`, `socketId`, `connected`, `joinedAt` |
| `lastActivityAt` | `Date` | default now; indexed for idle-room cleanup |
| `createdAt` / `updatedAt` | `Date` | added automatically (`timestamps: true`) |

Participant subdocument:

| Field | Type | Rules / default |
| --- | --- | --- |
| `userId` | `String` | required, max 64 |
| `name` | `String` | required, 1–40 chars |
| `role` | `String` | `host` \| `moderator` \| `participant`, default `participant` |
| `socketId` | `String \| null` | default `null` |
| `connected` | `Boolean` | default `false` |
| `joinedAt` | `Date` | default now |

Schema-level rules enforced on save:

1. `roomId` is unique (index created automatically in development).
2. A room holds **at most 20** participants.
3. `userId` values are unique inside a room.
4. A room has **at most one** host, and `hostId` must match that participant.
5. No participants → host check is skipped (room can be created before anyone joins).

Helpers:

```js
Room.findByRoomId('abc123')   // normalises to ABC123
room.isHost(userId)
room.getParticipant(userId)
room.markActivity()           // updates lastActivityAt
```

## 3. Configure MongoDB Atlas

1. Sign in at <https://cloud.mongodb.com> and create a **free M0 cluster**.
2. **Database Access → Add New Database User** → username + password.
   - Avoid `@ : / ? # [ ] %` in the password, or URL-encode them.
3. **Network Access → Add IP Address** → for local development:
   - your current IP, **or** `0.0.0.0/0` (allow from anywhere — dev only).
4. **Database → Connect → Drivers → Node.js** → copy the connection string:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Put it in `backend/.env` (never commit this file):
   ```dotenv
   MONGODB_URI=mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB=youtube_party
   ```
6. Verify:
   ```bash
   cd backend
   npm run verify:db
   npm run dev
   ```
   `GET /api/health` should show `"database": { "state": "connected", "name": "youtube_party" }`.

## 4. Verify without Atlas

```bash
cd backend
npm run verify:db
```

- With `MONGODB_URI` set → tests against **your** database (it creates and deletes
  `ABC123`-style test rooms).
- Without `MONGODB_URI` → starts a temporary in-memory MongoDB via
  `mongodb-memory-server`, runs the same checks, then deletes everything.
  This is a **test-only** dependency; the real server never uses it.

Checks performed: connection, status reporting, unique index, create/read, timestamps,
defaults, code normalisation, duplicate rejection, invalid `videoId`, negative
`currentTime`, bad `playbackStatus`, mismatched `hostId`, missing host.

## 5. Verified vs not verified

| Behaviour | Status |
| --- | --- |
| `connectDB()` against a real `mongod` | ✅ verified (in-memory MongoDB 11.3.0) |
| `Room` schema validation + indexes | ✅ 13/13 checks pass |
| Startup fails clearly with no `MONGODB_URI` | ✅ verified (exit code 1) |
| Startup fails clearly with unreachable host | ✅ verified (exit code 1, hints printed) |
| `GET /api/health` reports DB state | ✅ verified (`state: "connected"`) |
| **Your Atlas cluster** | ❌ not tested — needs your credentials |

## 6. Troubleshooting

| Message | Meaning | Fix |
| --- | --- | --- |
| `MONGODB_URI is not set.` | No `.env` / empty value | Copy `.env.example` → `.env`, paste URI |
| `bad auth` / `Authentication failed` | Wrong user or password | Re-check Database Access; URL-encode special chars |
| `ENOTFOUND` / `querySrv` | Wrong cluster host | Recopy the string from Atlas |
| `ECONNREFUSED` | Nothing listening on host:port | Start local `mongod` or use the `mongodb+srv://` URI |
| `Server selection timed out` | IP blocked / VPN / firewall | Add your IP in Network Access |
| `MongoParseError` | Malformed URI | Must start with `mongodb://` or `mongodb+srv://` |
