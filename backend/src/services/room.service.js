import { randomUUID } from 'node:crypto'
import Room, { MAX_PARTICIPANTS } from '../models/Room.js'
import { AppError } from '../utils/AppError.js'
import { generateRoomCode } from '../utils/roomCode.js'
import { signParticipantToken } from '../utils/tokens.js'

/** Collision retries before we give up. 32^6 codes make more than 2 unlikely. */
const MAX_CODE_ATTEMPTS = 8

function toParticipantLimitError() {
  return AppError.conflict(
    'room_full',
    `This room already has the maximum of ${MAX_PARTICIPANTS} participants`,
  )
}

/**
 * Creates a room and registers the creator as its host.
 * Room codes come from a CSPRNG; the unique index is the real collision guard.
 */
export async function createRoom({ hostName, hostId, videoId = null }) {
  const hostUserId = hostId?.trim() || randomUUID()
  const now = new Date()

  const roomData = {
    hostId: hostUserId,
    controllerId: hostUserId,
    videoId: videoId ?? null,
    playbackStatus: 'paused',
    currentTime: 0,
    playbackUpdatedAt: now,
    lastActivityAt: now,
    participants: [
      {
        userId: hostUserId,
        name: hostName,
        role: 'host',
        connected: false,
        joinedAt: now,
      },
    ],
  }

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    try {
      const room = await Room.create({ ...roomData, roomId: generateRoomCode() })
      return {
        room: room.toJSON(),
        hostId: hostUserId,
        token: signParticipantToken({ userId: hostUserId, roomId: room.roomId }),
      }
    } catch (error) {
      // Duplicate roomId -> try another code. Anything else is a real failure.
      if (error?.code === 11000) continue
      throw error
    }
  }

  throw AppError.serviceUnavailable(
    'room_code_unavailable',
    'Could not allocate a unique room code, please try again',
  )
}

/** Fetches a room or throws a 404 the client can act on. */
export async function getRoom(roomId) {
  const room = await Room.findByRoomId(roomId)

  if (!room) {
    throw AppError.notFound(`Room ${roomId} does not exist`)
  }

  return { room: room.toJSON() }
}

/**
 * Adds a participant to a room, or refreshes an existing one (idempotent).
 * Returns `joined: true` only when a new participant was added.
 */
export async function joinRoom({ roomId, name, userId }) {
  const room = await Room.findByRoomId(roomId)

  if (!room) {
    throw AppError.notFound(`Room ${roomId} does not exist`)
  }

  const participantId = userId?.trim() || randomUUID()
  const existing = room.getParticipant(participantId)

  if (existing) {
    existing.name = name
    existing.connected = true
    room.markActivity()
    await saveRoom(room)
    return {
      room: room.toJSON(),
      userId: participantId,
      joined: false,
      token: signParticipantToken({ userId: participantId, roomId: room.roomId }),
    }
  }

  if (room.participants.length >= MAX_PARTICIPANTS) {
    throw toParticipantLimitError()
  }

  room.participants.push({
    userId: participantId,
    name,
    role: 'participant',
    connected: true,
    joinedAt: new Date(),
  })
  room.markActivity()
  await saveRoom(room)

  return {
    room: room.toJSON(),
    userId: participantId,
    joined: true,
    token: signParticipantToken({ userId: participantId, roomId: room.roomId }),
  }
}

async function saveRoom(room) {
  try {
    await room.save()
  } catch (error) {
    if (error?.name === 'ValidationError') {
      const messages = Object.values(error.errors)
        .map((validationError) => validationError.message)
        .join('; ')

      if (/more than \d+ participants/i.test(messages)) {
        throw toParticipantLimitError()
      }
      if (/userIds must be unique/i.test(messages)) {
        throw AppError.conflict(
          'participant_conflict',
          'This user already joined the room, please retry',
        )
      }
      throw AppError.badRequest(messages)
    }
    throw error
  }
}
