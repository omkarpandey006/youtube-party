import Room, { YOUTUBE_ID_PATTERN } from '../models/Room.js'
import { logger } from '../utils/logger.js'

/** Every client applies an action at this server time, hiding network jitter. */
export const EXECUTE_WINDOW_MS = 250
const SNAPSHOT_WINDOW_MS = 120
const HEARTBEAT_WINDOW_MS = 80
const HEARTBEAT_INTERVAL_MS = 3000
const MAX_POSITION_SECONDS = 24 * 60 * 60

const heartbeatTimers = new Map()

export function channelName(roomId) {
  return `room:${roomId}`
}

export function roundPosition(value) {
  return Math.round(value * 1000) / 1000
}

/** userId allowed to change playback: explicit controller, else the host. */
export function controllerOf(room) {
  return room.controllerId || room.hostId
}

export function isPlaybackController(room, userId) {
  return Boolean(userId) && controllerOf(room) === userId
}

/** Host and Moderator can control video playback; Participants cannot. */
export function canControlPlayback(room, userId) {
  if (!userId) return false
  if (typeof room.canControlPlayback === 'function') {
    return room.canControlPlayback(userId)
  }
  if (room.hostId === userId) return true
  const participant = typeof room.getParticipant === 'function' ? room.getParticipant(userId) : null
  if (participant && (participant.role === 'host' || participant.role === 'moderator')) {
    return true
  }
  return false
}

/**
 * Authoritative state at `now`. When playing, the position is extrapolated from
 * the last saved anchor, so a late joiner starts at the right second.
 */
export function buildPlaybackState(room, now, options = {}) {
  const updatedAt = room.playbackUpdatedAt ? new Date(room.playbackUpdatedAt).getTime() : now
  const base = Number(room.currentTime) || 0
  const elapsed =
    room.playbackStatus === 'playing' ? Math.max(0, (now - updatedAt) / 1000) : 0

  return {
    roomId: room.roomId,
    videoId: room.videoId ?? null,
    status: room.playbackStatus,
    position: roundPosition(base + elapsed),
    seq: room.seq ?? 0,
    serverTime: now,
    updatedAt,
    controllerId: controllerOf(room),
    executeAt: options.executeAt ?? now + EXECUTE_WINDOW_MS,
    ...(options.heartbeat ? { heartbeat: true } : {}),
    ...(options.snapshot ? { snapshot: true } : {}),
  }
}

export function broadcastPlaybackState(io, room, now = Date.now(), options = {}) {
  const payload = buildPlaybackState(room, now, options)
  io.to(channelName(room.roomId)).emit('playback_state', payload)
  return payload
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

function readPosition(payload) {
  const value = payload?.position
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > MAX_POSITION_SECONDS) return null
  return roundPosition(value)
}

function readVideoId(payload) {
  const value = payload?.videoId
  return typeof value === 'string' && YOUTUBE_ID_PATTERN.test(value.trim())
    ? value.trim()
    : null
}

async function loadJoinedRoom(socket, ack) {
  const roomId = socket.data.roomId
  if (!roomId) {
    reply(ack, fail('not_in_room', 'Join a room before controlling playback'))
    return null
  }

  const room = await Room.findByRoomId(roomId)
  if (!room) {
    reply(ack, fail('room_not_found', 'Room does not exist'))
    return null
  }

  return room
}

/**
 * Validates authorization + payload, applies the mutation and broadcasts the
 * new authoritative state. Returns nothing; the ack carries the result.
 */
async function runCommand(io, socket, ack, apply) {
  try {
    const room = await loadJoinedRoom(socket, ack)
    if (!room) return

    if (!canControlPlayback(room, socket.data.userId)) {
      return reply(
        ack,
        fail('forbidden', 'Only hosts and moderators can control playback'),
      )
    }

    const mutation = apply(room)
    if (!mutation.ok) return reply(ack, fail(mutation.code, mutation.message))

    const now = Date.now()
    room.controllerId = socket.data.userId
    room.seq = (room.seq ?? 0) + 1
    room.playbackUpdatedAt = new Date(now)
    room.markActivity()
    await room.save()

    const payload = broadcastPlaybackState(io, room, now)
    return reply(
      ack,
      succeed({
        seq: payload.seq,
        executeAt: payload.executeAt,
        position: payload.position,
        status: payload.status,
        videoId: payload.videoId,
      }),
    )
  } catch (error) {
    logger.error(`playback command failed for socket ${socket.id}:`, error)
    return reply(ack, fail('internal_error', 'Could not update playback'))
  }
}

function attachCommands(io, socket) {
  socket.on('playback_play', (payload, ack) => {
    void runCommand(io, socket, ack, (room) => {
      const position = readPosition(payload)
      if (position === null) {
        return { ok: false, code: 'validation_error', message: 'position must be a number between 0 and 86400' }
      }
      if (!room.videoId) {
        return { ok: false, code: 'validation_error', message: 'No video is loaded in this room' }
      }
      room.currentTime = position
      room.playbackStatus = 'playing'
      return { ok: true }
    })
  })

  socket.on('playback_pause', (payload, ack) => {
    void runCommand(io, socket, ack, (room) => {
      const position = readPosition(payload)
      if (position === null) {
        return { ok: false, code: 'validation_error', message: 'position must be a number between 0 and 86400' }
      }
      room.currentTime = position
      room.playbackStatus = 'paused'
      return { ok: true }
    })
  })

  socket.on('playback_ended', (payload, ack) => {
    void runCommand(io, socket, ack, (room) => {
      const position = readPosition(payload)
      room.currentTime = position !== null ? position : room.currentTime
      room.playbackStatus = 'ended'
      return { ok: true }
    })
  })

  socket.on('playback_seek', (payload, ack) => {
    void runCommand(io, socket, ack, (room) => {
      const position = readPosition(payload)
      if (position === null) {
        return { ok: false, code: 'validation_error', message: 'position must be a number between 0 and 86400' }
      }
      if (!room.videoId) {
        return { ok: false, code: 'validation_error', message: 'No video is loaded in this room' }
      }
      room.currentTime = position
      if (room.playbackStatus === 'ended') room.playbackStatus = 'paused'
      return { ok: true }
    })
  })

  socket.on('playback_change_video', (payload, ack) => {
    void runCommand(io, socket, ack, (room) => {
      const videoId = readVideoId(payload)
      if (!videoId) {
        return { ok: false, code: 'validation_error', message: 'videoId must be a valid 11-character YouTube id' }
      }
      room.videoId = videoId
      room.currentTime = 0
      room.playbackStatus = 'paused'
      return { ok: true }
    })
  })
}

function attachControlTransfer(io, socket) {
  socket.on('playback_grant_control', async (payload, ack) => {
    try {
      const room = await loadJoinedRoom(socket, ack)
      if (!room) return

      if (!room.canModerate(socket.data.userId)) {
        return reply(
          ack,
          fail('forbidden', 'Only the host or a moderator can change playback control'),
        )
      }

      const targetId = typeof payload?.userId === 'string' ? payload.userId.trim() : ''
      if (!targetId || targetId.length > 64) {
        return reply(ack, fail('validation_error', 'userId is required'))
      }

      const target = room.getParticipant(targetId)
      if (!target) {
        return reply(ack, fail('not_a_participant', 'That user is not in this room'))
      }

      room.controllerId = targetId
      room.markActivity()
      await room.save()

      const control = {
        roomId: room.roomId,
        controllerId: targetId,
        hostId: room.hostId,
      }
      io.to(channelName(room.roomId)).emit('control_changed', control)
      return reply(ack, succeed(control))
    } catch (error) {
      logger.error(`grant control failed for socket ${socket.id}:`, error)
      return reply(ack, fail('internal_error', 'Could not transfer playback control'))
    }
  })
}

export function attachPlaybackHandlers(io, socket) {
  socket.on('clock_ping', (_payload, ack) => {
    reply(ack, succeed({ serverTime: Date.now() }))
  })

  socket.on('playback_request_state', async (_payload, ack) => {
    try {
      const room = await loadJoinedRoom(socket, ack)
      if (!room) return

      const now = Date.now()
      const payload = buildPlaybackState(room, now, {
        executeAt: now + SNAPSHOT_WINDOW_MS,
        snapshot: true,
      })
      socket.emit('playback_state', payload)
      return reply(ack, succeed(payload))
    } catch (error) {
      logger.error(`playback snapshot failed for socket ${socket.id}:`, error)
      return reply(ack, fail('internal_error', 'Could not load playback state'))
    }
  })

  attachCommands(io, socket)
  attachControlTransfer(io, socket)
}

/** Sends the current state to a socket that just joined (late-join sync). */
export function sendPlaybackSnapshot(socket, room, now = Date.now()) {
  socket.emit(
    'playback_state',
    buildPlaybackState(room, now, {
      executeAt: now + SNAPSHOT_WINDOW_MS,
      snapshot: true,
    }),
  )
}

export function startRoomHeartbeat(io, roomId) {
  if (heartbeatTimers.has(roomId)) return

  const timer = setInterval(async () => {
    try {
      const room = await Room.findByRoomId(roomId)
      if (!room) {
        stopRoomHeartbeat(roomId)
        return
      }
      // Paused players cannot drift; only playing rooms need corrections.
      if (room.playbackStatus !== 'playing') return

      const now = Date.now()
      io.to(channelName(roomId)).emit(
        'playback_state',
        buildPlaybackState(room, now, {
          executeAt: now + HEARTBEAT_WINDOW_MS,
          heartbeat: true,
        }),
      )
    } catch (error) {
      logger.error(`playback heartbeat failed for room ${roomId}:`, error)
    }
  }, HEARTBEAT_INTERVAL_MS)

  timer.unref?.()
  heartbeatTimers.set(roomId, timer)
}

export function stopRoomHeartbeat(roomId) {
  const timer = heartbeatTimers.get(roomId)
  if (!timer) return
  clearInterval(timer)
  heartbeatTimers.delete(roomId)
}

export function stopAllHeartbeats() {
  for (const roomId of heartbeatTimers.keys()) stopRoomHeartbeat(roomId)
}
