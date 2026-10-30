import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Room from '../src/models/Room.js'
import { findSuccessor } from '../src/sockets/roles.js'

describe('Role & Permission Model Logic', () => {
  it('identifies host, moderator, and permissions correctly on Room documents', () => {
    const room = new Room({
      roomId: 'ABCDEF',
      hostId: 'host-1',
      controllerId: 'host-1',
      participants: [
        { userId: 'host-1', name: 'Alice', role: 'host' },
        { userId: 'mod-1', name: 'Bob', role: 'moderator' },
        { userId: 'member-1', name: 'Charlie', role: 'participant' },
      ],
    })

    // Alice is host
    assert.equal(room.isHost('host-1'), true)
    assert.equal(room.isHost('mod-1'), false)
    assert.equal(room.isHost('member-1'), false)
    assert.equal(room.isHost('unknown'), false)

    // Bob is moderator
    assert.equal(room.isModerator('mod-1'), true)
    assert.equal(room.isModerator('host-1'), false)
    assert.equal(room.isModerator('member-1'), false)

    // Moderate permissions (host or moderator)
    assert.equal(room.canModerate('host-1'), true)
    assert.equal(room.canModerate('mod-1'), true)
    assert.equal(room.canModerate('member-1'), false)
    assert.equal(room.canModerate('stranger'), false)

    // Playback control (Host and Moderator only)
    assert.equal(room.canControlPlayback('host-1'), true)
    assert.equal(room.canControlPlayback('mod-1'), true)
    assert.equal(room.canControlPlayback('member-1'), false)
    assert.equal(room.canControlPlayback('unknown'), false)
  })

  it('enforces assign_role permission rules', () => {
    const room = new Room({
      roomId: 'ABCDEF',
      hostId: 'host-1',
      controllerId: 'host-1',
      participants: [
        { userId: 'host-1', name: 'Alice', role: 'host' },
        { userId: 'mod-1', name: 'Bob', role: 'moderator' },
        { userId: 'member-1', name: 'Charlie', role: 'participant' },
      ],
    })

    function attemptAssignRole(callerId, targetUserId, newRole) {
      if (!room.isHost(callerId)) {
        return { ok: false, code: 'forbidden', message: 'Only the host can assign roles' }
      }
      if (!targetUserId) {
        return { ok: false, code: 'validation_error', message: 'userId is required' }
      }
      if (newRole !== 'moderator' && newRole !== 'participant') {
        return { ok: false, code: 'validation_error', message: 'Role must be moderator or participant' }
      }
      const target = room.getParticipant(targetUserId)
      if (!target) {
        return { ok: false, code: 'not_a_participant', message: 'User not found in room' }
      }
      if (target.userId === room.hostId) {
        return { ok: false, code: 'invalid_role_target', message: 'Cannot reassign host role' }
      }
      target.role = newRole
      return { ok: true, target }
    }

    // Moderator cannot assign roles
    const modAttempt = attemptAssignRole('mod-1', 'member-1', 'moderator')
    assert.equal(modAttempt.ok, false)
    assert.equal(modAttempt.code, 'forbidden')

    // Participant cannot assign roles
    const memberAttempt = attemptAssignRole('member-1', 'mod-1', 'participant')
    assert.equal(memberAttempt.ok, false)
    assert.equal(memberAttempt.code, 'forbidden')

    // Host cannot reassign own host role via assign_role
    const hostSelfAttempt = attemptAssignRole('host-1', 'host-1', 'participant')
    assert.equal(hostSelfAttempt.ok, false)
    assert.equal(hostSelfAttempt.code, 'invalid_role_target')

    // Host promotes member to moderator
    const promoteSuccess = attemptAssignRole('host-1', 'member-1', 'moderator')
    assert.equal(promoteSuccess.ok, true)
    assert.equal(room.getParticipant('member-1').role, 'moderator')

    // Host demotes moderator to participant
    const demoteSuccess = attemptAssignRole('host-1', 'mod-1', 'participant')
    assert.equal(demoteSuccess.ok, true)
    assert.equal(room.getParticipant('mod-1').role, 'participant')
  })

  it('enforces transfer_host rules and cascades roles', () => {
    const room = new Room({
      roomId: 'ABCDEF',
      hostId: 'host-1',
      controllerId: 'host-1',
      participants: [
        { userId: 'host-1', name: 'Alice', role: 'host' },
        { userId: 'mod-1', name: 'Bob', role: 'moderator' },
      ],
    })

    function attemptTransferHost(callerId, targetUserId) {
      if (!room.isHost(callerId)) {
        return { ok: false, code: 'forbidden', message: 'Only the host can transfer host status' }
      }
      if (!targetUserId || targetUserId === room.hostId) {
        return { ok: false, code: 'validation_error', message: 'Invalid target' }
      }
      const target = room.getParticipant(targetUserId)
      if (!target) {
        return { ok: false, code: 'not_a_participant', message: 'User not found' }
      }

      const prevHost = room.getParticipant(room.hostId)
      if (prevHost) prevHost.role = 'moderator'
      target.role = 'host'
      const prevHostId = room.hostId
      room.hostId = target.userId
      if (room.controllerId === prevHostId) {
        room.controllerId = target.userId
      }
      return { ok: true, newHostId: target.userId }
    }

    // Non-host cannot transfer
    const failTransfer = attemptTransferHost('mod-1', 'host-1')
    assert.equal(failTransfer.ok, false)
    assert.equal(failTransfer.code, 'forbidden')

    // Host transfers to Bob
    const success = attemptTransferHost('host-1', 'mod-1')
    assert.equal(success.ok, true)
    assert.equal(room.hostId, 'mod-1')
    assert.equal(room.controllerId, 'mod-1')
    assert.equal(room.getParticipant('mod-1').role, 'host')
    assert.equal(room.getParticipant('host-1').role, 'moderator')
  })

  it('enforces remove_participant: ONLY host can remove participants', () => {
    const room = new Room({
      roomId: 'ABCDEF',
      hostId: 'host-1',
      controllerId: 'host-1',
      participants: [
        { userId: 'host-1', name: 'Alice', role: 'host' },
        { userId: 'mod-1', name: 'Bob', role: 'moderator' },
        { userId: 'member-1', name: 'Charlie', role: 'participant' },
      ],
    })

    function attemptRemove(callerId, targetUserId) {
      if (!room.isHost(callerId)) {
        return { ok: false, code: 'forbidden', message: 'Only the host can remove participants' }
      }
      if (targetUserId === callerId) {
        return { ok: false, code: 'bad_request', message: 'Cannot remove self' }
      }
      const target = room.getParticipant(targetUserId)
      if (!target) {
        return { ok: false, code: 'not_a_participant', message: 'Target not found' }
      }
      if (target.userId === room.hostId) {
        return { ok: false, code: 'forbidden', message: 'Cannot remove host' }
      }
      room.participants = room.participants.filter((p) => p.userId !== targetUserId)
      return { ok: true, removedUserId: targetUserId }
    }

    // Regular member cannot remove anyone
    assert.equal(attemptRemove('member-1', 'mod-1').code, 'forbidden')
    assert.equal(attemptRemove('member-1', 'host-1').code, 'forbidden')

    // Moderator CANNOT remove participant (Only Host can remove participants)
    const modAttempt = attemptRemove('mod-1', 'member-1')
    assert.equal(modAttempt.ok, false)
    assert.equal(modAttempt.code, 'forbidden')

    // Moderator cannot remove host
    assert.equal(attemptRemove('mod-1', 'host-1').code, 'forbidden')

    // Host cannot remove self
    assert.equal(attemptRemove('host-1', 'host-1').code, 'bad_request')

    // Host can remove moderator
    const hostRemovesMod = attemptRemove('host-1', 'mod-1')
    assert.equal(hostRemovesMod.ok, true)
    assert.equal(room.getParticipant('mod-1'), null)

    // Host can remove participant
    const hostRemovesMember = attemptRemove('host-1', 'member-1')
    assert.equal(hostRemovesMember.ok, true)
    assert.equal(room.getParticipant('member-1'), null)
  })

  it('selects successor accurately during host fallback', () => {
    const t0 = new Date('2026-01-01T10:00:00Z')
    const t1 = new Date('2026-01-01T10:01:00Z')
    const t2 = new Date('2026-01-01T10:02:00Z')
    const t3 = new Date('2026-01-01T10:03:00Z')

    // Scenario 1: Connected moderator is selected over connected participant
    const roomWithMod = {
      participants: [
        { userId: 'host-1', role: 'host', connected: false, joinedAt: t0 },
        { userId: 'user-1', role: 'participant', connected: true, joinedAt: t1 },
        { userId: 'mod-1', role: 'moderator', connected: true, joinedAt: t2 },
      ],
    }
    const succ1 = findSuccessor(roomWithMod, 'host-1')
    assert.equal(succ1.userId, 'mod-1')

    // Scenario 2: If no moderator, oldest connected participant is selected
    const roomOnlyUsers = {
      participants: [
        { userId: 'host-1', role: 'host', connected: false, joinedAt: t0 },
        { userId: 'user-2', role: 'participant', connected: true, joinedAt: t2 },
        { userId: 'user-1', role: 'participant', connected: true, joinedAt: t1 },
        { userId: 'user-3', role: 'participant', connected: false, joinedAt: t0 },
      ],
    }
    const succ2 = findSuccessor(roomOnlyUsers, 'host-1')
    assert.equal(succ2.userId, 'user-1')

    // Scenario 3: If no connected users, oldest disconnected participant
    const roomAllDisconnected = {
      participants: [
        { userId: 'host-1', role: 'host', connected: false, joinedAt: t0 },
        { userId: 'user-2', role: 'participant', connected: false, joinedAt: t3 },
        { userId: 'user-1', role: 'participant', connected: false, joinedAt: t1 },
      ],
    }
    const succ3 = findSuccessor(roomAllDisconnected, 'host-1')
    assert.equal(succ3.userId, 'user-1')

    // Scenario 4: No other participants
    const emptyRoom = {
      participants: [{ userId: 'host-1', role: 'host', connected: false, joinedAt: t0 }],
    }
    assert.equal(findSuccessor(emptyRoom, 'host-1'), null)
  })

  it('enforces playback control: Host and Moderator can control, Participant cannot', () => {
    const room = new Room({
      roomId: 'ABCDEF',
      hostId: 'host-1',
      controllerId: 'host-1',
      participants: [
        { userId: 'host-1', name: 'Alice', role: 'host' },
        { userId: 'mod-1', name: 'Bob', role: 'moderator' },
        { userId: 'member-1', name: 'Charlie', role: 'participant' },
      ],
    })

    function attemptPlaybackCommand(callerId) {
      if (!room.canControlPlayback(callerId)) {
        return { ok: false, code: 'forbidden', message: 'Only hosts and moderators can control playback' }
      }
      return { ok: true, controlledBy: callerId }
    }

    // Host can control playback
    const hostCommand = attemptPlaybackCommand('host-1')
    assert.equal(hostCommand.ok, true)
    assert.equal(hostCommand.controlledBy, 'host-1')

    // Moderator can control playback
    const modCommand = attemptPlaybackCommand('mod-1')
    assert.equal(modCommand.ok, true)
    assert.equal(modCommand.controlledBy, 'mod-1')

    // Participant CANNOT control playback
    const memberCommand = attemptPlaybackCommand('member-1')
    assert.equal(memberCommand.ok, false)
    assert.equal(memberCommand.code, 'forbidden')

    // Unknown stranger cannot control playback
    const strangerCommand = attemptPlaybackCommand('stranger')
    assert.equal(strangerCommand.ok, false)
    assert.equal(strangerCommand.code, 'forbidden')
  })
})
