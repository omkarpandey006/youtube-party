import { io, type Socket } from 'socket.io-client'
import type { Participant, PlaybackStatus, Room, RoomSession } from '../types/room'

export type {
  Participant,
  ParticipantRole,
  PlaybackStatus,
  Room,
  RoomSelf,
  RoomSession,
} from '../types/room'

export type SocketResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      code: string
      message: string
      details?: Array<{ field: string; message: string }>
    }

export interface JoinRoomPayload {
  roomId: string
  token: string
}

/** Server-authoritative playback state (positions are seconds). */
export interface PlaybackStatePayload {
  roomId: string
  videoId: string | null
  status: PlaybackStatus
  position: number
  seq: number
  serverTime: number
  updatedAt: number
  controllerId: string
  executeAt: number
  heartbeat?: boolean
  snapshot?: boolean
}

export interface PlaybackCommandAck {
  seq: number
  executeAt: number
  position: number
  status: PlaybackStatus
  videoId: string | null
}

export interface ControlChangedPayload {
  roomId: string
  controllerId: string
  hostId: string
}

type Ack<T> = (result: SocketResult<T>) => void

export interface ServerToClientEvents {
  room_state: (payload: RoomSession) => void
  participant_joined: (payload: {
    roomId: string
    participant: Participant
    participants: Participant[]
  }) => void
  participant_updated: (payload: {
    roomId: string
    participants: Participant[]
  }) => void
  participant_left: (payload: {
    roomId: string
    userId: string
    username: string | null
    removed: boolean
    participants: Participant[]
  }) => void
  playback_state: (payload: PlaybackStatePayload) => void
  control_changed: (payload: ControlChangedPayload) => void
}

export interface ClientToServerEvents {
  join_room: (payload: JoinRoomPayload, ack: Ack<RoomSession>) => void
  leave_room: (payload: Record<string, never>, ack: Ack<{ roomId: string }>) => void
  clock_ping: (
    payload: Record<string, never>,
    ack: Ack<{ serverTime: number }>,
  ) => void
  playback_request_state: (
    payload: Record<string, never>,
    ack: Ack<PlaybackStatePayload>,
  ) => void
  playback_play: (payload: { position: number }, ack: Ack<PlaybackCommandAck>) => void
  playback_pause: (payload: { position: number }, ack: Ack<PlaybackCommandAck>) => void
  playback_seek: (payload: { position: number }, ack: Ack<PlaybackCommandAck>) => void
  playback_change_video: (
    payload: { videoId: string },
    ack: Ack<PlaybackCommandAck>,
  ) => void
  playback_grant_control: (
    payload: { userId: string },
    ack: Ack<ControlChangedPayload>,
  ) => void
}

export type WatchPartySocket = Socket<ServerToClientEvents, ClientToServerEvents>

/** Must match the server default (Socket.IO's `/socket.io`). */
export const SOCKET_PATH = '/socket.io'

/**
 * `VITE_SOCKET_URL` is the **backend** origin (e.g. `http://localhost:5000`).
 * A pasted `/socket.io` suffix is stripped so the path is never doubled.
 * Empty means "same origin" (works when the Vite proxy is healthy).
 */
function normalizeSocketUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/socket\.io$/i, '')
}

export const SOCKET_URL = normalizeSocketUrl(import.meta.env.VITE_SOCKET_URL ?? '')

if (import.meta.env.DEV) {
  console.info(
    `[socket] target ${SOCKET_URL || window.location.origin}${SOCKET_PATH}`,
  )
}

/**
 * Creates a Socket.IO client pointed at the backend, never at the Vite dev
 * server. It does not connect automatically: join the room on `connect` (and
 * again after every reconnect) using the participant token.
 *
 * `tryAllTransports` makes the client fall back to HTTP long-polling when a
 * network/proxy blocks the WebSocket upgrade instead of failing forever.
 */
export function createWatchPartySocket(options?: { url?: string }): WatchPartySocket {
  const url = options?.url ?? SOCKET_URL

  return io(url || undefined, {
    path: SOCKET_PATH,
    autoConnect: false,
    withCredentials: true,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}

/*
 * One shared socket per tab. Several mounts (React StrictMode, fast route
 * changes) reuse the same instance instead of opening clients that fight each
 * other; the connection is closed only after the last consumer releases it.
 */
let sharedSocket: WatchPartySocket | null = null
let consumers = 0
let releaseTimer: number | null = null

export function acquireWatchPartySocket(): WatchPartySocket {
  if (!sharedSocket) sharedSocket = createWatchPartySocket()

  consumers += 1
  if (releaseTimer !== null) {
    window.clearTimeout(releaseTimer)
    releaseTimer = null
  }

  return sharedSocket
}

/**
 * Releases the shared socket. The disconnect is deferred by one task so a
 * React StrictMode remount reuses the in-flight connection instead of aborting
 * the WebSocket handshake ("closed before the connection is established").
 */
export function releaseWatchPartySocket(): void {
  consumers = Math.max(0, consumers - 1)
  if (consumers > 0 || releaseTimer !== null) return

  releaseTimer = window.setTimeout(() => {
    releaseTimer = null
    if (consumers > 0) return

    sharedSocket?.removeAllListeners()
    sharedSocket?.disconnect()
  }, 0)
}

/** Room type re-exported for consumers that only import the socket module. */
export type SocketRoom = Room

export default createWatchPartySocket
