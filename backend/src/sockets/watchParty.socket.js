import { Server } from 'socket.io'
import { env } from '../config/env.js'
import Room from '../models/Room.js'
import { logger } from '../utils/logger.js'
import { isValidRoomCode, normalizeRoomCode } from '../utils/roomCode.js'
import { verifyParticipantToken } from '../utils/tokens.js'
import {
  attachPlaybackHandlers,
  channelName,
  sendPlaybackSnapshot,
  startRoomHeartbeat,
  stopAllHeartbeats,
  stopRoomHeartbeat,
} from './playback.js'

/**
 * In-memory presence registry: roomId -> userId -> Set<socketId>.
 * A participant can have several tabs open, so "left" is only broadcast when
 * their last socket disconnects.
 */
const roomConnections = new Map()

function addConnection(roomId, userId, socketId) {
  let users = roomConnections.get(roomId)
  if (!users) {
    users = new Map()
    roomConnections.set(roomId, users)
  }

  let sockets = users.get(userId)
  const isFirstSocket = !sockets
  if (!sockets) {
    sockets = new Set()
    users.set(userId, sockets)
  }

  sockets.add(socketId)
  return isFirstSocket
}

function removeConnection(roomId, userId, socketId) {
  const users = roomConnections.get(roomId)
  if (!users) return { socketsLeft: 0 }

  const sockets = users.get(userId)
  if (!sockets) return { socketsLeft: 0 }

  sockets.delete(socketId)
  if (sockets.size > 0) return { socketsLeft: sockets.size }

  users.delete(userId)
  if (users.size === 0) roomConnections.delete(roomId)
  return { socketsLeft: 0 }
}

/** Removes server-internal fields (socketId) from a participant subdocument. */
function toPublicParticipant(participant) {
  const plain = typeof participant.toObject === 'function' ? participant.toObject() : participant
  const { socketId, ...rest } = plain
  return rest
}

function reply(ack, result) {
  if (typeof ack === 'function') ack(result)
}

function fail(code, message) {
  return { ok: false, code, message }
}

function succeed(data) {
  return { ok: true, data }
}

async function handleJoin(io, socket, payload, ack) {
  try {
    if (socket.data.roomId) {
      return reply(ack, fail('already_in_room', 'This connection already joined a room'))
    }

    const rawRoomId = payload?.roomId
    if (!isValidRoomCode(rawRoomId)) {
      return reply(ack, fail('validation_error', 'roomId must be exactly 6 letters or digits'))
    }
    const roomId = normalizeRoomCode(rawRoomId)

    // Identity comes from the signed token, never from the socket payload.
    const claims = verifyParticipantToken(payload?.token)
    if (!claims || claims.roomId !== roomId) {
      return reply(
        ack,
        fail('invalid_token', 'Participant token is missing, invalid, expired or for another room'),
      )
    }

    const room = await Room.findByRoomId(roomId)
    if (!room) {
      return reply(ack, fail('room_not_found', 'Room does not exist'))
    }

    const participant = room.getParticipant(claims.userId)
    if (!participant) {
      return reply(ack, fail('not_a_participant', 'Token does not belong to a participant of this room'))
    }

    // Role is always taken from the database row, never from the client.
    const isFirstSocket = addConnection(roomId, participant.userId, socket.id)
    socket.data.roomId = roomId
    socket.data.userId = participant.userId
    socket.join(channelName(roomId))

    participant.connected = true
    participant.socketId = socket.id
    room.lastActivityAt = new Date()
    await room.save()

    const roomPayload = room.toJSON()
    const self = { userId: participant.userId, role: participant.role }

    socket.emit('room_state', { room: roomPayload, self })
    sendPlaybackSnapshot(socket, room)
    startRoomHeartbeat(io, roomId)

    if (isFirstSocket) {
      socket.to(channelName(roomId)).emit('participant_joined', {
        roomId,
        participant: toPublicParticipant(participant),
        participants: roomPayload.participants,
      })
    } else {
      // Same person opened another tab: presence did not change.
      socket.to(channelName(roomId)).emit('participant_updated', {
        roomId,
        participants: roomPayload.participants,
      })
    }

    logger.info(`Socket ${socket.id} joined room ${roomId} as ${participant.userId}`)
    return reply(ack, succeed({ room: roomPayload, self }))
  } catch (error) {
    logger.error(`join_room failed for socket ${socket.id}:`, error)
    return reply(ack, fail('internal_error', 'Could not join the room'))
  }
}

async function detachFromRoom(io, socket, { removeParticipant = false } = {}) {
  const roomId = socket.data.roomId
  const userId = socket.data.userId

  if (!roomId || !userId) return { roomId: null, removed: false }

  socket.data.roomId = null
  socket.data.userId = null
  socket.leave(channelName(roomId))

  const { socketsLeft } = removeConnection(roomId, userId, socket.id)
  if (socketsLeft > 0) return { roomId, removed: false }

  try {
    const room = await Room.findByRoomId(roomId)
    if (!room) return { roomId, removed: false }

    const participant = room.getParticipant(userId)
    let removed = false

    if (removeParticipant && participant && participant.role !== 'host') {
      // An explicit "Leave room" frees the seat. A dropped socket does not,
      // so the same person can reclaim their seat after a reconnect.
      room.participants = room.participants.filter((item) => item.userId !== userId)
      removed = true
    } else if (participant) {
      participant.connected = false
      participant.socketId = null
    }

    room.markActivity()
    await room.save()

    logger.info(`Socket ${socket.id} left room ${roomId} (removed: ${removed})`)

    io.to(channelName(roomId)).emit('participant_left', {
      roomId,
      userId,
      username: participant?.name ?? null,
      removed,
      participants: room.toJSON().participants,
    })

    const channel = io.sockets.adapter.rooms.get(channelName(roomId))
    if (!channel || channel.size === 0) stopRoomHeartbeat(roomId)

    return { roomId, removed }
  } catch (error) {
    logger.error(`Failed to clean up presence for ${userId} in ${roomId}:`, error)
  }

  return { roomId, removed: false }
}

async function handleLeave(io, socket, ack) {
  if (!socket.data.roomId) {
    return reply(ack, fail('not_in_room', 'This connection is not in a room'))
  }

  const { roomId } = await detachFromRoom(io, socket, { removeParticipant: true })
  return reply(ack, succeed({ roomId }))
}

function isOriginAllowed(origin) {
  // No Origin header: native/mobile/same-origin clients (tests, server-to-server).
  if (!origin) return true
  return env.allowedOrigins.includes(origin)
}

/**
 * Attaches Socket.IO to the existing HTTP server.
 * Returns the server so the caller can close it during shutdown.
 */
export function initWatchPartySocket(httpServer) {
  const io = new Server(httpServer, {
    serveClient: false,
    cors: {
      origin: env.allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // CORS headers are only enforced by browsers, and not at all for raw
    // WebSockets, so reject disallowed origins during the handshake too.
    allowRequest: (req, callback) => {
      if (isOriginAllowed(req.headers.origin)) return callback(null, true)
      logger.warn(`Rejected socket handshake from origin ${req.headers.origin}`)
      return callback('origin_not_allowed', false)
    },
    maxHttpBufferSize: env.socket.maxHttpBufferSize,
  })

  io.engine.on('close', stopAllHeartbeats)

  io.on('connection', (socket) => {
    socket.data.roomId = null
    socket.data.userId = null
    logger.info(`Socket connected: ${socket.id} (origin: ${socket.handshake.headers.origin ?? 'none'})`)

    attachPlaybackHandlers(io, socket)

    socket.on('join_room', (payload, ack) => {
      void handleJoin(io, socket, payload, ack)
    })

    socket.on('leave_room', (_payload, ack) => {
      void handleLeave(io, socket, ack)
    })

    socket.on('disconnect', (reason) => {
      void detachFromRoom(io, socket).finally(() => {
        logger.info(`Socket disconnected: ${socket.id} (${reason})`)
      })
    })
  })

  return io
}

/** Exposed for tests/monitoring: number of users currently connected in a room. */
export function getConnectedParticipantCount(roomId) {
  return roomConnections.get(normalizeRoomCode(roomId))?.size ?? 0
}
