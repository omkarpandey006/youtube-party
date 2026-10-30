import Room from '../models/Room.js'
import { logger } from '../utils/logger.js'
import { channelName } from './playback.js'
import { evictUserFromRoom } from './watchParty.socket.js'

export const HOST_FALLBACK_GRACE_MS = 15_000

const hostFallbackTimers = new Map()

export function findSuccessor(room, excludeUserId) {
  const eligible = room.participants.filter((p) => p.userId !== excludeUserId)
  if (eligible.length === 0) return null

  // Priority 1: Connected moderators, ordered by joinedAt
  const connectedMods = eligible
    .filter((p) => p.connected && p.role === 'moderator')
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
  if (connectedMods.length > 0) return connectedMods[0]

  // Priority 2: Connected participants, ordered by joinedAt
  const connectedUsers = eligible
    .filter((p) => p.connected && p.role === 'participant')
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
  if (connectedUsers.length > 0) return connectedUsers[0]

  // Priority 3: Disconnected moderators
  const disconnectedMods = eligible
    .filter((p) => p.role === 'moderator')
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
  if (disconnectedMods.length > 0) return disconnectedMods[0]

  // Priority 4: Disconnected participants
  const disconnectedUsers = eligible
    .filter((p) => p.role === 'participant')
    .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())
  return disconnectedUsers[0] ?? null
}

export function scheduleHostFallback(io, roomId, hostId, graceMs = HOST_FALLBACK_GRACE_MS) {
  cancelHostFallback(roomId)

  const timer = setTimeout(async () => {
    hostFallbackTimers.delete(roomId)
    try {
      const room = await Room.findByRoomId(roomId)
      if (!room) return

      if (room.hostId === hostId) {
        const hostParticipant = room.getParticipant(hostId)
        if (hostParticipant && !hostParticipant.connected) {
          const successor = findSuccessor(room, hostId)
          if (successor) {
            hostParticipant.role = 'moderator'
            successor.role = 'host'
            room.hostId = successor.userId
            if (room.controllerId === hostId) {
              room.controllerId = successor.userId
            }
            room.markActivity()
            await room.save()

            const roomPayload = room.toJSON()
            logger.info(
              `Host fallback: transferred host of room ${roomId} from ${hostId} to ${successor.userId}`,
            )

            io.to(channelName(roomId)).emit('host_transferred', {
              roomId,
              previousHostId: hostId,
              newHostId: successor.userId,
              participants: roomPayload.participants,
              fallback: true,
            })
            io.to(channelName(roomId)).emit('participant_updated', {
              roomId,
              participants: roomPayload.participants,
            })
            io.to(channelName(roomId)).emit('control_changed', {
              roomId,
              controllerId: room.controllerId,
              hostId: room.hostId,
            })
          }
        }
      }
    } catch (error) {
      logger.error(`Error executing host fallback for room ${roomId}:`, error)
    }
  }, graceMs)

  timer.unref?.()
  hostFallbackTimers.set(roomId, timer)
}

export function cancelHostFallback(roomId) {
  const timer = hostFallbackTimers.get(roomId)
  if (timer) {
    clearTimeout(timer)
    hostFallbackTimers.delete(roomId)
  }
}

export function stopAllHostFallbacks() {
  for (const timer of hostFallbackTimers.values()) {
    clearTimeout(timer)
  }
  hostFallbackTimers.clear()
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

async function loadJoinedRoom(socket, ack) {
  const roomId = socket.data.roomId
  if (!roomId) {
    reply(ack, fail('not_in_room', 'Join a room before performing this action'))
    return null
  }

  const room = await Room.findByRoomId(roomId)
  if (!room) {
    reply(ack, fail('room_not_found', 'Room does not exist'))
    return null
  }

  return room
}

export function attachRoleHandlers(io, socket) {
  socket.on('assign_role', async (payload, ack) => {
    try {
      const room = await loadJoinedRoom(socket, ack)
      if (!room) return

      if (!room.isHost(socket.data.userId)) {
        return reply(
          ack,
          fail('forbidden', 'Only the host can assign or revoke moderator privileges'),
        )
      }

      const targetUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : ''
      const targetRole = typeof payload?.role === 'string' ? payload.role.trim() : ''

      if (!targetUserId) {
        return reply(ack, fail('validation_error', 'userId is required'))
      }
      if (targetRole !== 'moderator' && targetRole !== 'participant') {
        return reply(ack, fail('validation_error', 'Role must be moderator or participant'))
      }

      const target = room.getParticipant(targetUserId)
      if (!target) {
        return reply(ack, fail('not_a_participant', 'User not found in room'))
      }
      if (target.userId === room.hostId) {
        return reply(
          ack,
          fail('invalid_role_target', 'Cannot reassign host role. Use transfer_host instead.'),
        )
      }

      target.role = targetRole
      room.markActivity()
      await room.save()

      const roomPayload = room.toJSON()
      io.to(channelName(room.roomId)).emit('role_assigned', {
        roomId: room.roomId,
        userId: target.userId,
        role: target.role,
        participants: roomPayload.participants,
      })
      io.to(channelName(room.roomId)).emit('participant_updated', {
        roomId: room.roomId,
        participants: roomPayload.participants,
      })

      return reply(
        ack,
        succeed({
          userId: target.userId,
          role: target.role,
          participants: roomPayload.participants,
        }),
      )
    } catch (error) {
      logger.error(`assign_role failed on socket ${socket.id}:`, error)
      return reply(ack, fail('internal_error', 'Could not assign role'))
    }
  })

  socket.on('transfer_host', async (payload, ack) => {
    try {
      const room = await loadJoinedRoom(socket, ack)
      if (!room) return

      if (!room.isHost(socket.data.userId)) {
        return reply(ack, fail('forbidden', 'Only the host can transfer host status'))
      }

      const targetUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : ''
      if (!targetUserId) {
        return reply(ack, fail('validation_error', 'userId is required'))
      }
      if (targetUserId === room.hostId) {
        return reply(ack, fail('validation_error', 'You are already the host'))
      }

      const target = room.getParticipant(targetUserId)
      if (!target) {
        return reply(ack, fail('not_a_participant', 'User not found in room'))
      }

      const previousHost = room.getParticipant(room.hostId)
      if (previousHost) {
        previousHost.role = 'moderator'
      }
      target.role = 'host'
      const previousHostId = room.hostId
      room.hostId = target.userId

      if (room.controllerId === previousHostId || !room.controllerId) {
        room.controllerId = target.userId
      }

      room.markActivity()
      await room.save()

      const roomPayload = room.toJSON()
      io.to(channelName(room.roomId)).emit('host_transferred', {
        roomId: room.roomId,
        previousHostId,
        newHostId: target.userId,
        participants: roomPayload.participants,
      })
      io.to(channelName(room.roomId)).emit('participant_updated', {
        roomId: room.roomId,
        participants: roomPayload.participants,
      })
      io.to(channelName(room.roomId)).emit('control_changed', {
        roomId: room.roomId,
        controllerId: room.controllerId,
        hostId: room.hostId,
      })

      return reply(
        ack,
        succeed({ hostId: target.userId, participants: roomPayload.participants }),
      )
    } catch (error) {
      logger.error(`transfer_host failed on socket ${socket.id}:`, error)
      return reply(ack, fail('internal_error', 'Could not transfer host status'))
    }
  })

  socket.on('remove_participant', async (payload, ack) => {
    try {
      const room = await loadJoinedRoom(socket, ack)
      if (!room) return

      const callerId = socket.data.userId
      if (!room.isHost(callerId)) {
        return reply(
          ack,
          fail('forbidden', 'Only the host can remove participants'),
        )
      }

      const targetUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : ''
      if (!targetUserId) {
        return reply(ack, fail('validation_error', 'userId is required'))
      }
      if (targetUserId === callerId) {
        return reply(ack, fail('bad_request', 'Use leave_room to leave the room'))
      }

      const target = room.getParticipant(targetUserId)
      if (!target) {
        return reply(ack, fail('not_a_participant', 'User not found in room'))
      }

      if (target.userId === room.hostId) {
        return reply(ack, fail('forbidden', 'The host cannot be removed'))
      }

      evictUserFromRoom(
        io,
        room.roomId,
        targetUserId,
        'You were removed from the room by the host.',
      )

      room.participants = room.participants.filter((p) => p.userId !== targetUserId)
      const controllerChanged = room.controllerId === targetUserId
      if (controllerChanged) {
        room.controllerId = room.hostId
      }

      room.markActivity()
      await room.save()

      const roomPayload = room.toJSON()
      io.to(channelName(room.roomId)).emit('participant_left', {
        roomId: room.roomId,
        userId: targetUserId,
        username: target.name,
        removed: true,
        participants: roomPayload.participants,
      })
      io.to(channelName(room.roomId)).emit('participant_updated', {
        roomId: room.roomId,
        participants: roomPayload.participants,
      })
      if (controllerChanged) {
        io.to(channelName(room.roomId)).emit('control_changed', {
          roomId: room.roomId,
          controllerId: room.controllerId,
          hostId: room.hostId,
        })
      }

      return reply(
        ack,
        succeed({
          userId: targetUserId,
          removed: true,
          participants: roomPayload.participants,
        }),
      )
    } catch (error) {
      logger.error(`remove_participant failed on socket ${socket.id}:`, error)
      return reply(ack, fail('internal_error', 'Could not remove participant'))
    }
  })
}
