export type ParticipantRole = 'host' | 'moderator' | 'participant'

export type PlaybackStatus = 'paused' | 'playing' | 'ended'

export interface Participant {
  userId: string
  name: string
  role: ParticipantRole
  connected: boolean
  joinedAt: string
}

export interface Room {
  roomId: string
  videoId: string | null
  playbackStatus: PlaybackStatus
  currentTime: number
  playbackUpdatedAt: string
  hostId: string
  /** userId allowed to change playback; defaults to the host. */
  controllerId: string | null
  /** Incremented by every playback command. */
  seq: number
  participants: Participant[]
  lastActivityAt: string
  createdAt: string
  updatedAt: string
}

export interface RoomSelf {
  userId: string
  role: ParticipantRole
}

export interface RoomSession {
  room: Room
  self: RoomSelf
}
