export type HealthResponse = {
  status: string
  service: string
  uptime: number
  timestamp: string
  database: {
    state: 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown'
    name: string | null
  }
}

export type {
  Participant,
  ParticipantRole,
  PlaybackStatus,
  Room,
  RoomSelf,
  RoomSession,
} from '../types/room'

import type { Room } from '../types/room'

export interface ValidationDetail {
  field: string
  message: string
}

interface ApiSuccess<T> {
  ok: true
  data: T
}

interface ApiFailure {
  ok: false
  code: string
  message: string
  details?: ValidationDetail[]
}

type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure

export interface CreateRoomResponse {
  room: Room
  hostId: string
  token: string
}

export interface GetRoomResponse {
  room: Room
}

export interface JoinRoomResponse {
  room: Room
  userId: string
  joined: boolean
  token: string
}

/** Error thrown for every non-2xx API response, network failure and bad payload. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: ValidationDetail[]

  constructor(code: string, message: string, status = 0, details: ValidationDetail[] = []) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(
      'network_error',
      'Cannot reach the server. Check that the backend is running and try again.',
    )
  }

  let payload: ApiEnvelope<T> | null = null
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    payload = null
  }

  if (!response.ok || !payload || payload.ok !== true) {
    const failure = payload && payload.ok === false ? payload : null

    throw new ApiError(
      failure?.code ?? 'request_failed',
      failure?.message ?? `${response.status} ${response.statusText}`,
      response.status,
      failure?.details ?? [],
    )
  }

  return payload.data
}

/** `/api/health` is intentionally un-enveloped, so it bypasses `request`. */
export async function getHealth(): Promise<HealthResponse> {
  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}/api/health`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    throw new ApiError('network_error', 'Cannot reach the server.')
  }

  if (!response.ok) {
    throw new ApiError('health_unavailable', `${response.status} ${response.statusText}`, response.status)
  }

  return (await response.json()) as HealthResponse
}

export function createRoom(input: {
  hostName: string
  hostId?: string
  videoId?: string | null
}): Promise<CreateRoomResponse> {
  return request<CreateRoomResponse>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getRoom(roomId: string): Promise<GetRoomResponse> {
  return request<GetRoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}`)
}

export function joinRoom(
  roomId: string,
  input: { name: string; userId?: string },
): Promise<JoinRoomResponse> {
  return request<JoinRoomResponse>(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
