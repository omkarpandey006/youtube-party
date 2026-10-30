# TASKS

Phase-by-phase roadmap for the YouTube Party project.

Legend: `[x]` done and verified · `[ ]` not implemented yet.

**Overall status: Phase 5 complete (local YouTube player) · Phase 6 (sync engine) next.**

---

## Phase 1 — Project setup ✅

- [x] Root structure (`frontend/`, `backend/`, `docs/`, `README.md`, `TASKS.md`, `.gitignore`)
- [x] Frontend scaffolded with React + Vite + TypeScript
- [x] React Router configured
- [x] Frontend folders (`components`, `pages`, `hooks`, `services`, `socket`, `utils`)
- [x] Backend scaffolded with Node + Express (JS, ES modules)
- [x] Backend folders (`config`, `models`, `controllers`, `routes`, `services`, `middleware`, `sockets`, `utils`)
- [x] Minimal Express server with `GET /api/health`
- [x] `.env.example` for frontend and backend (no real credentials)
- [x] Root `.gitignore`
- [x] Setup instructions in `README.md`
- [x] Dependencies installed and checks run

**Verified:** frontend `build` + `lint` ✅ · backend `check` ✅ · health 200 ✅ · 404 ✅ · Vite proxy ✅

---

## Phase 2 — MongoDB database setup ✅

- [x] Install and configure Mongoose (`^9.11.4`)
- [x] `backend/src/config/db.js` — `connectDB()`, `disconnectDB()`, `getDatabaseStatus()`
- [x] `backend/src/models/Room.js` — room schema with validation
- [x] Room fields: unique `roomId`, `videoId`, `playbackStatus`, `currentTime`, `hostId`, `participants[]`, timestamps
- [x] Defaults + schema validation (enums, lengths, unique index, host consistency)
- [x] Connection through `process.env.MONGODB_URI`
- [x] Startup connects before listening and fails fast with clear, credential-free errors
- [x] Secrets kept out of source and Git
- [x] `backend/.env.example` with placeholders
- [x] `npm run verify:db` integration check (13 assertions)

**Verified:** 13/13 checks on a real `mongod` ✅ · missing/invalid URI → exit 1 with hints ✅ ·
health reports `database.state` ✅ · Atlas connection confirmed manually ✅

---

## Phase 3 — Backend room APIs ✅

- [x] `POST /api/rooms` — create a room, creator becomes host (`201`)
- [x] `GET /api/rooms/:roomId` — fetch room state (`200` / `404`)
- [x] `POST /api/rooms/:roomId/join` — join or rejoin (`200` / `404` / `409`)
- [x] `GET /api/health` kept and extended with database status
- [x] Service layer (`room.service.js`) separated from controllers and routes
- [x] Secure room codes via `crypto.randomInt` + unique-index retry (max 8 attempts)
- [x] Request validation with zod (body + params, unknown fields rejected)
- [x] Centralized error handler: 400/404/409/413/500 envelopes, no stack traces or secrets
- [x] `socketId` stripped from every API response
- [x] Room data persisted in MongoDB
- [x] API tests: `node:test` + `supertest` (20 assertions, in-memory MongoDB)
- [x] `docs/API.md` with request/response examples and error codes

**Verified:** `npm test` → **20/20 pass** ✅ · `npm run check` ✅ ·
manual REST checks against Atlas (create → get → join → invalid → 404) ✅ ·
test room cleaned up (`rooms_left=0`) ✅

**Not implemented on purpose:** Socket.IO, roles/permissions, auth.

---

## Phase 4 — Socket.IO realtime & room UI ✅

**Realtime server (done)**

- [x] Socket.IO mounted on the existing HTTP server
- [x] `backend/src/sockets/watchParty.socket.js`
- [x] `join_room` / `leave_room` events with acknowledgement envelopes
- [x] `room_state`, `participant_joined`, `participant_updated`, `participant_left` broadcasts
- [x] Room id validation + invalid-join rejection
- [x] Disconnect cleanup (presence registry, DB `connected` / `socketId`)
- [x] Signed participant tokens (HMAC, room-bound, 12 h TTL) issued by REST
- [x] Roles always read from MongoDB — client-sent `role` / `socketId` ignored
- [x] Allowed origins via `CLIENT_ORIGIN`; `*` rejected in production
- [x] Production refuses to boot without `SESSION_SECRET`
- [x] Frontend socket client `frontend/src/socket/socket.ts` (typed, `autoConnect: false`)
- [x] Vite dev proxy for `/socket.io` (ws)
- [x] `docs/SOCKET_EVENTS.md`
- [x] Tests: 12 socket tests + `npm run smoke:socket` (two real clients)

**Room UI (done)**

- [x] Frontend home page: create room / join by code or full room link
- [x] Frontend room page: participant list, roles, connected dots, copy link, leave room
- [x] `useRoom()` hook wiring REST tokens into the socket client
- [x] Reconnect UX: auto-rejoin on reconnect, token refresh via REST when expired
- [x] Per-tab identity in `sessionStorage` (two tabs = two participants)
- [x] Explicit leave frees the seat; dropped sockets keep it for reclaim
- [x] Inline validation + API error messages (`room_full`, `not_found`, …)

**Verified:** `npm test` → **34/34 pass** ✅ · `npm run smoke:socket` → **10/10 pass**
against Atlas ✅ · frontend `build` + `lint` ✅ · real browser two-tab test ✅
(create → join → live list → leave frees seat → refresh reclaims host → server restart
recovers via token refresh).

**Done when:** two browsers open the app, join the same room and see each other live. ✅

---

## Phase 5 — YouTube player integration ✅

- [x] `frontend/src/components/VideoPlayer.jsx` using the official IFrame Player API
- [x] API loader (`frontend/src/utils/youtubeIframe.ts`) — script injected once, shared promise
- [x] `isValidYouTubeVideoId()` guard — no raw/arbitrary iframe HTML from user input
- [x] Play / pause / seek / current-time + duration reporting
- [x] Loading, ready, empty and error UI (with retry)
- [x] `onReady` / `onStateChange` / `onTimeUpdate` / `onError` callbacks + imperative ref
- [x] Responsive 16:9 frame, custom controls (`controls=0`, `playsinline=1`)
- [x] Player destroyed and iframe removed on unmount / video change
- [x] Privacy-enhanced embed host (`youtube-nocookie.com`)
- [x] `docs/PLAYER.md`

**Verified:** frontend `build` + `lint` ✅ · real browser test with `aqz-KE-bpKQ`
(Ready → Play advances time → Pause freezes → seek to 5:00) ✅ · error state with
`AAAAAAAAAAA` (embedding blocked) ✅ · iframe removed after navigation ✅

**Done when:** a room video plays locally with working play/pause/seek. ✅

---

## Phase 6 — Strict sync engine (<300 ms drift)

- [ ] Server-authoritative clock (`clock_ping` / `clock_pong`, min-RTT offset estimate)
- [ ] Playback state broadcast: `playbackStatus`, `currentTime`, `playbackUpdatedAt`, `seq`, `executeAt`
- [ ] Scheduled apply window (~250 ms) so all clients act on the same server timestamp
- [ ] `play`, `pause`, `seek`, `change_video` events with `seq` ordering
- [ ] Late-joiner snapshot with time compensation
- [ ] Heartbeat re-broadcast every 3 s
- [ ] 3-tier drift control: ignore (<150 ms) → `playbackRate` nudge (150–900 ms) → hard seek (>900 ms)
- [ ] Wire the existing `VideoPlayer` ref callbacks into the sync engine
- [ ] Drift HUD (dev only)
- [ ] Vitest unit tests for sync math

**Done when:** measured drift stays under 300 ms across a 10-minute video on two devices.

---

## Phase 7 — Roles & permissions

- [ ] Role model enforced server-side: `host` / `moderator` / `participant`
- [ ] Permission checks for every mutating event
- [ ] `assign_role`, `transfer_host`, `remove_participant`
- [ ] Request → approve control flow
- [ ] UI: role badges, host controls, approval panel
- [ ] Host fallback when the host disconnects

**Done when:** a participant calling a host-only event gets `{ ok: false, code: "forbidden" }`.

---

## Phase 8 — Persistence & room lifecycle

- [ ] Debounced persistence (~1.2 s) so every event is not a DB write
- [ ] Restore active rooms on server boot
- [ ] Idle room cleanup using `lastActivityAt` (`ROOM_IDLE_MINUTES`)
- [ ] Chat history persistence
- [ ] Participant `connected` / `socketId` maintenance across restarts

**Done when:** restarting the server restores rooms, video position and chat.

---

## Phase 9 — Chat, reactions & UX polish

- [ ] Room chat with rate limiting and length cap
- [ ] Emoji reactions floating over the player
- [ ] Toasts + `app_error` surfacing
- [ ] Loading / empty / error states everywhere
- [ ] Responsive layout (mobile + desktop)
- [ ] Keyboard shortcuts and focus states

---

## Phase 10 — Testing & quality gate

- [ ] Socket.IO smoke test suite
- [ ] Unit tests for permissions and sync math
- [ ] `TESTING.md` manual multi-device checklist
- [ ] Clean `npm run build` + lint on both sides
- [ ] Basic accessibility pass

---

## Phase 11 — Docs, deployment & demo

- [ ] `WALKTHROUGH.md`
- [ ] `DEMO_SCRIPT.md`
- [ ] Production build served by Express from one origin
- [ ] `render.yaml` (or chosen host) deploy config + Atlas production URI
- [ ] Live URL added to `README.md`

---

## Future / optional

- [ ] Authentication (JWT or Google OAuth)
- [ ] Redis adapter for multi-instance Socket.IO
- [ ] Voice chat (WebRTC)
- [ ] Collaborative video queue / playlist
- [ ] Playback-speed voting
- [ ] Room history and "continue watching"
