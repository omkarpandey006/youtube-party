# YouTube Party

Watch YouTube together in sync. Full-stack project built phase by phase.

| Layer | Stack |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite, React Router |
| Backend | Node.js + Express (JavaScript, ES modules) |
| Database | MongoDB + Mongoose |
| Realtime | Socket.IO (same HTTP server) |

> **Current status: Phase 6 complete — synchronized YouTube playback.**
> Create/join rooms, see participants live, and watch YouTube videos in real-time
> sync with play/pause/seek/change-video and automatic drift correction (<300 ms).
> Chat and advanced roles are planned for next phases.

---

## Project structure

```
youtub-party/
├── frontend/                     # React + TypeScript + Vite
│   ├── src/
│   │   ├── components/           # header, participant list, room view, VideoPlayer
│   │   ├── pages/                # Home, Room, 404
│   │   ├── hooks/                # usePageTitle, useRoom (socket lifecycle)
│   │   ├── services/             # api.ts (REST), session.ts (per-tab identity)
│   │   ├── socket/               # typed Socket.IO client
│   │   ├── types/                # Room / Participant types
│   │   └── utils/                # room code, YouTube id parsing, API loader
│   ├── .env.example
│   └── vite.config.ts            # dev proxy: /api + /socket.io -> :5000
│
├── backend/                      # Express API (ES modules)
│   ├── src/
│   │   ├── config/
│   │   │   ├── env.js            # environment variables
│   │   │   └── db.js             # Mongoose connection + error explanations
│   │   ├── controllers/          # health + room handlers
│   │   ├── middleware/           # validation, 404, centralized errors
│   │   ├── models/
│   │   │   └── Room.js           # room + participant schema
│   │   ├── routes/               # /api/health, /api/rooms
│   │   ├── services/
│   │   │   └── room.service.js   # create / get / join logic
│   │   ├── sockets/
│   │   │   └── watchParty.socket.js  # join/leave presence + broadcasts
│   │   ├── utils/                # logger, redaction, room codes, tokens, schemas
│   │   ├── app.js                # Express app factory
│   │   └── index.js              # connect DB -> HTTP server + Socket.IO
│   ├── scripts/
│   │   ├── socket-smoke.mjs      # two-client presence smoke test
│   │   └── verify-db.js          # database integration check
│   ├── tests/
│   │   ├── rooms.test.js         # REST API tests
│   │   └── socket.test.js        # Socket.IO tests
│   └── .env.example
│
├── docs/
│   ├── architecture.md
│   ├── API.md                    # REST reference
│   ├── database.md               # schema + Atlas setup + troubleshooting
│   ├── PLAYER.md                 # player component, states, restrictions
│   └── SOCKET_EVENTS.md          # realtime event reference
├── TASKS.md                      # phase-by-phase roadmap
├── README.md
└── .gitignore
```

---

## Requirements

- Node.js **20+** (tested on Node 24)
- npm **10+**
- A MongoDB database — free **MongoDB Atlas** cluster is enough

## Setup

```bash
git clone <your-repo-url>
cd youtub-party
```

### 1. Create a MongoDB Atlas cluster

1. Sign in at <https://cloud.mongodb.com> → create a free **M0** cluster.
2. **Database Access** → add a database user (note the username and password).
3. **Network Access** → add your current IP (or `0.0.0.0/0` for local development).
4. **Database → Connect → Drivers → Node.js** → copy the connection string.

Full walkthrough with troubleshooting: [docs/database.md](./docs/database.md).

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Edit `backend/.env` and paste your Atlas string into `MONGODB_URI`:

```dotenv
MONGODB_URI=mongodb+srv://myuser:mypassword@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=youtube_party
```

Then:

```bash
npm run verify:db             # optional: 13 database checks
npm run dev                   # http://localhost:5000
```

Check it:

```bash
curl http://localhost:5000/api/health
```

```json
{
  "status": "ok",
  "service": "youtube-party-backend",
  "uptime": 2.11,
  "timestamp": "2026-01-01T00:00:00.000Z",
  "database": { "state": "connected", "name": "youtube_party" }
}
```

If MongoDB is unreachable the server **exits with code 1** and prints the redacted URI,
the reason (bad auth, DNS, IP whitelist, timeout…) and how to fix it.

### 3. Frontend

Open a second terminal:

```bash
cd frontend
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# then set VITE_SOCKET_URL=http://localhost:5000 in frontend/.env
npm run dev                   # http://localhost:5173
```

Open <http://localhost:5173>, enter a name and **Create room** (paste a YouTube
link to load a video). To test the realtime layer, open a second tab (or another
browser/device on the same network), paste the room link/code and join — both
participant lists update instantly.

The room's video plays locally with play/pause/seek. Synchronized playback lands
in Phase 6 ([docs/PLAYER.md](./docs/PLAYER.md)).

Two tabs count as two different participants on purpose (identity lives in
`sessionStorage`). "Leave room" frees the seat; closing a tab keeps the seat
reserved for a reconnect.

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `5000` | HTTP port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed CORS + Socket.IO origin(s), comma-separated; `*` rejected in production |
| `SESSION_SECRET` | _required in production_ | HMAC secret for participant tokens; dev falls back to an ephemeral secret |
| `PARTICIPANT_TOKEN_TTL_MS` | `43200000` (12 h) | Participant token lifetime |
| `SOCKET_MAX_BUFFER_BYTES` | `100000` | Max socket message size |
| `MONGODB_URI` | _required_ | Atlas / local connection string |
| `MONGODB_DB` | `youtube_party` | Database name inside the cluster |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | How long to wait for a reachable server |
| `MONGODB_CONNECT_TIMEOUT_MS` | `10000` | TCP connect timeout |

### Frontend (`frontend/.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | _empty_ | Leave empty to use the Vite proxy |
| `VITE_SOCKET_URL` | _empty_ | Socket.IO **backend origin** (e.g. `http://localhost:5000`). Set it to bypass the Vite WebSocket proxy; empty means same origin |

> `.env` files are git-ignored. Only `.env.example` is committed, and it contains no real
> credentials. Connection strings are redacted before they reach any log. Restart
> `npm run dev` after changing a `VITE_*` value — Vite reads env at startup.

---

## Database model (Phase 2)

`backend/src/models/Room.js`

| Field | Type | Notes |
| --- | --- | --- |
| `roomId` | `String` | Unique 6-char code (`A-Z0-9`), used in the room URL |
| `videoId` | `String \| null` | YouTube video id (11 chars) |
| `playbackStatus` | `paused` \| `playing` \| `ended` | Default `paused` |
| `currentTime` | `Number` | Seconds, `>= 0` |
| `playbackUpdatedAt` | `Date` | Timestamp for `currentTime` |
| `hostId` | `String` | Must match the participant with role `host` |
| `participants[]` | subdocument[] | `userId`, `name`, `role`, `socketId`, `connected`, `joinedAt` |
| `lastActivityAt` | `Date` | Used later for idle-room cleanup |
| `createdAt` / `updatedAt` | `Date` | Automatic |

Validation includes a unique `roomId`, max 20 participants, unique `userId`s per room,
one host per room, a YouTube-id pattern and role enums. Details: [docs/database.md](./docs/database.md).

---

## Scripts

### backend/

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with `node --watch` |
| `npm start` | Run the server once |
| `npm run check` | Syntax-check the API source files |
| `npm test` | REST + Socket.IO tests (in-memory MongoDB, no Atlas needed) |
| `npm run smoke:socket` | Two-client presence check against a running server |
| `npm run verify:db` | Database integration check (uses Atlas if configured, otherwise an in-memory MongoDB) |

### frontend/

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Type-check (`tsc -b`) + production build |
| `npm run preview` | Preview the production build |
| `npm run lint` | oxlint |

---

## Routes

| Route | Description |
| --- | --- |
| `/` | Create a room or join by link/code |
| `/room/:roomCode` | Room: video player, participant list, connection status |
| `*` | 404 page |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Service + database status |
| `POST` | `/api/rooms` | Create a room (creator becomes host) |
| `GET` | `/api/rooms/:roomId` | Fetch a room |
| `POST` | `/api/rooms/:roomId/join` | Join or rejoin a room |

Request/response examples, status codes and error envelopes: [docs/API.md](./docs/API.md).

## Socket.IO

| Event | Direction | Purpose |
| --- | --- | --- |
| `join_room` | client → server | Join with `{ roomId, token }` (ack + `room_state`) |
| `leave_room` | client → server | Leave the current room (ack) |
| `participant_joined` | server → room | A participant's first socket connected |
| `participant_updated` | server → room | Same participant opened another tab |
| `participant_left` | server → room | Participant's last socket disconnected |

Identity is a signed token (HMAC-SHA256, room-bound, 12 h TTL) issued by the REST API.
Roles come from MongoDB — client-sent `role` / `socketId` are ignored.
Full reference: [docs/SOCKET_EVENTS.md](./docs/SOCKET_EVENTS.md).

The client connects to the **backend origin** from `VITE_SOCKET_URL`
(`http://localhost:5000`), not to the Vite dev URL, and reuses one shared socket per
tab. If you see `WebSocket connection to 'ws://localhost:5173/socket.io' failed`,
check that `frontend/.env` sets `VITE_SOCKET_URL=http://localhost:5000` and restart
`npm run dev`.

## Playback (Phase 5)

`frontend/src/components/VideoPlayer.jsx` wraps the official YouTube IFrame Player
API: validated 11-char ids only (no raw iframe HTML), privacy-enhanced
`youtube-nocookie.com` embed, custom play/pause + seek + live time, and
loading/empty/error states with retry. The player is destroyed on unmount.

Playback is local per participant — sync events are Phase 6. Component API,
error codes and browser restrictions: [docs/PLAYER.md](./docs/PLAYER.md).

---

## Roadmap

See [TASKS.md](./TASKS.md). Phases 1–5 are complete; next up is the strict
playback sync engine (Phase 6).
