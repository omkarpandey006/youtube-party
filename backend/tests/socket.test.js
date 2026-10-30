// Development secret for the test process only. Never used in production.
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef'

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import request from 'supertest'
import { io as ioClient } from 'socket.io-client'
import { createApp } from '../src/app.js'
import { connectDB, disconnectDB } from '../src/config/db.js'
import Room from '../src/models/Room.js'
import {
  getConnectedParticipantCount,
  initWatchPartySocket,
} from '../src/sockets/watchParty.socket.js'

let mongo
let httpServer
let io
let app
let baseUrl
const clients = []

function newClient() {
  const socket = ioClient(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  })
  clients.push(socket)
  return socket
}

function waitForEvent(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`Timed out waiting for "${event}"`))
    }, timeout)

    function handler(payload) {
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }

    socket.on(event, handler)
  })
}

async function connect(socket) {
  const connected = waitForEvent(socket, 'connect')
  socket.connect()
  await connected
  return socket
}

function emitAck(socket, event, payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) reject(error)
      else resolve(response)
    })
  })
}

function join(socket, roomId, token, extra = {}) {
  return emitAck(socket, 'join_room', { roomId, token, ...extra })
}

async function createRoomWithGuest() {
  const created = await request(app)
    .post('/api/rooms')
    .send({ hostName: 'Host User' })
  const { roomId } = created.body.data.room
  const { token: hostToken, hostId } = created.body.data

  const joined = await request(app)
    .post(`/api/rooms/${roomId}/join`)
    .send({ name: 'Guest User' })
  const { token: guestToken, userId: guestId } = joined.body.data

  return { roomId, hostToken, hostId, guestToken, guestId }
}

before(async () => {
  mongo = await MongoMemoryServer.create()
  await connectDB({ uri: mongo.getUri(), quiet: true })
  app = createApp()
  httpServer = app.listen(0)
  await new Promise((resolve) => httpServer.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`
  io = initWatchPartySocket(httpServer)
})

after(async () => {
  await new Promise((resolve) => io.close(resolve))
  await disconnectDB()
  await mongo.stop()
})

beforeEach(async () => {
  await Room.deleteMany({})
})

afterEach(async () => {
  while (clients.length > 0) {
    const socket = clients.pop()
    socket.removeAllListeners()
    socket.disconnect()
  }
  // Give the server's async presence cleanup a moment before the DB closes.
  await new Promise((resolve) => setTimeout(resolve, 200))
})

describe('Socket.IO origin policy', () => {
  it('rejects a handshake from a disallowed origin', async () => {
    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'http://evil.example' },
    })
    assert.equal(response.status, 403)
  })

  it('accepts a handshake from an allowed origin', async () => {
    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(response.status, 200)
  })
})

describe('Socket.IO room presence', () => {
  it('lets two clients join and broadcasts participant_joined', async () => {
    const { roomId, hostToken, guestToken, guestId } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    const hostJoin = await join(hostSocket, roomId, hostToken)

    assert.equal(hostJoin.ok, true)
    assert.equal(hostJoin.data.self.role, 'host')
    assert.equal(hostJoin.data.room.roomId, roomId)
    assert.equal(hostJoin.data.room.participants.length, 2)
    assert.equal(hostJoin.data.room.participants[0].socketId, undefined)

    const guestSocket = await connect(newClient())
    const joinedEvent = waitForEvent(hostSocket, 'participant_joined')

    // A hostile client sends role/socketId — the server must ignore both.
    const guestJoin = await join(guestSocket, roomId, guestToken, {
      role: 'host',
      socketId: 'fake-socket',
    })

    assert.equal(guestJoin.ok, true)
    assert.equal(guestJoin.data.self.userId, guestId)
    assert.equal(guestJoin.data.self.role, 'participant')

    const event = await joinedEvent
    assert.equal(event.roomId, roomId)
    assert.equal(event.participant.userId, guestId)
    assert.equal(event.participant.role, 'participant')
    assert.equal(event.participants.length, 2)

    const room = await Room.findByRoomId(roomId)
    const storedGuest = room.getParticipant(guestId)
    assert.equal(storedGuest.role, 'participant')
    assert.equal(storedGuest.connected, true)
    assert.ok(storedGuest.socketId)
    assert.equal(getConnectedParticipantCount(roomId), 2)
  })

  it('broadcasts participant_left and marks the participant disconnected', async () => {
    const { roomId, hostToken, guestToken, guestId } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const leftEvent = waitForEvent(hostSocket, 'participant_left')
    guestSocket.disconnect()

    const event = await leftEvent
    assert.equal(event.userId, guestId)
    assert.equal(event.participants.length, 2)

    const room = await Room.findByRoomId(roomId)
    const storedGuest = room.getParticipant(guestId)
    assert.equal(storedGuest.connected, false)
    assert.equal(storedGuest.socketId, null)
    assert.equal(getConnectedParticipantCount(roomId), 1)
  })

  it('supports an explicit leave_room and rejects a second leave', async () => {
    const { roomId, hostToken, guestToken } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const leftEvent = waitForEvent(hostSocket, 'participant_left')
    const leaveAck = await emitAck(guestSocket, 'leave_room', {})
    await leftEvent

    assert.equal(leaveAck.ok, true)
    assert.equal(leaveAck.data.roomId, roomId)

    const secondLeave = await emitAck(guestSocket, 'leave_room', {})
    assert.equal(secondLeave.ok, false)
    assert.equal(secondLeave.code, 'not_in_room')
  })

  it('frees the seat when a participant explicitly leaves', async () => {
    const { roomId, hostToken, guestToken, guestId } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const leftEvent = waitForEvent(hostSocket, 'participant_left')
    await emitAck(guestSocket, 'leave_room', {})
    const event = await leftEvent

    assert.equal(event.userId, guestId)
    assert.equal(event.removed, true)
    assert.equal(event.participants.length, 1)
    assert.equal(event.participants[0].role, 'host')

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.getParticipant(guestId), null)
    assert.equal(room.participants.length, 1)
  })

  it('keeps the host seat when the host leaves explicitly', async () => {
    const { roomId, hostToken, hostId, guestToken } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const leftEvent = waitForEvent(guestSocket, 'participant_left')
    await emitAck(hostSocket, 'leave_room', {})
    const event = await leftEvent

    assert.equal(event.userId, hostId)
    assert.equal(event.removed, false)

    const room = await Room.findByRoomId(roomId)
    const host = room.getParticipant(hostId)
    assert.ok(host)
    assert.equal(host.role, 'host')
    assert.equal(host.connected, false)
  })

  it('rejects a malformed room id', async () => {
    const socket = await connect(newClient())
    const result = await join(socket, 'abc', 'whatever')

    assert.equal(result.ok, false)
    assert.equal(result.code, 'validation_error')
  })

  it('rejects a tampered token', async () => {
    const { roomId, hostToken } = await createRoomWithGuest()
    const socket = await connect(newClient())

    const result = await join(socket, roomId, `${hostToken}x`)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_token')
  })

  it('rejects a valid token minted for another room', async () => {
    const first = await createRoomWithGuest()
    const second = await createRoomWithGuest()

    const socket = await connect(newClient())
    const result = await join(socket, second.roomId, first.hostToken)

    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_token')
  })

  it('rejects a deleted room even with a valid token', async () => {
    const { roomId, hostToken } = await createRoomWithGuest()
    await Room.deleteMany({ roomId })

    const socket = await connect(newClient())
    const result = await join(socket, roomId, hostToken)

    assert.equal(result.ok, false)
    assert.equal(result.code, 'room_not_found')
  })

  it('rejects a token whose participant was removed from the room', async () => {
    const { roomId, guestToken, guestId } = await createRoomWithGuest()

    const room = await Room.findByRoomId(roomId)
    room.participants = room.participants.filter((p) => p.userId !== guestId)
    await room.save()

    const socket = await connect(newClient())
    const result = await join(socket, roomId, guestToken)

    assert.equal(result.ok, false)
    assert.equal(result.code, 'not_a_participant')
  })

  it('rejects joining twice from the same connection', async () => {
    const { roomId, hostToken } = await createRoomWithGuest()
    const socket = await connect(newClient())

    const first = await join(socket, roomId, hostToken)
    assert.equal(first.ok, true)

    const second = await join(socket, roomId, hostToken)
    assert.equal(second.ok, false)
    assert.equal(second.code, 'already_in_room')
  })

  it('keeps the participant connected while another tab is open', async () => {
    const { roomId, hostToken, guestToken, guestId } = await createRoomWithGuest()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestTabOne = await connect(newClient())
    await join(guestTabOne, roomId, guestToken)
    await waitForEvent(hostSocket, 'participant_joined')

    const guestTabTwo = await connect(newClient())
    const joinedAgain = waitForEvent(hostSocket, 'participant_updated')
    const secondJoin = await join(guestTabTwo, roomId, guestToken)
    await joinedAgain

    assert.equal(secondJoin.ok, true)

    guestTabOne.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 250))

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.getParticipant(guestId).connected, true)
    assert.equal(getConnectedParticipantCount(roomId), 2)
  })
})

async function createRoomWithVideo(videoId = 'aqz-KE-bpKQ') {
  const created = await request(app)
    .post('/api/rooms')
    .send({ hostName: 'Host User', videoId })
  const { roomId } = created.body.data.room
  const { token: hostToken, hostId } = created.body.data

  const joined = await request(app)
    .post(`/api/rooms/${roomId}/join`)
    .send({ name: 'Guest User' })
  const { token: guestToken, userId: guestId } = joined.body.data

  return { roomId, hostToken, hostId, guestToken, guestId }
}

function waitForPlaybackState(socket, predicate = () => true, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('playback_state', handler)
      reject(new Error('Timed out waiting for a matching playback_state'))
    }, timeout)

    function handler(payload) {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off('playback_state', handler)
      resolve(payload)
    }

    socket.on('playback_state', handler)
  })
}

describe('Socket.IO playback synchronization', () => {
  it('lets the host play and broadcasts the same state to everyone', async () => {
    const { roomId, hostToken, hostId, guestToken } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    const hostJoin = await join(hostSocket, roomId, hostToken)
    assert.equal(hostJoin.data.room.controllerId, hostId)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const hostState = waitForPlaybackState(hostSocket, (state) => !state.snapshot)
    const guestState = waitForPlaybackState(guestSocket, (state) => !state.snapshot)

    const ack = await emitAck(hostSocket, 'playback_play', { position: 42 })
    assert.equal(ack.ok, true)

    const [forHost, forGuest] = await Promise.all([hostState, guestState])
    assert.equal(forHost.status, 'playing')
    assert.equal(forGuest.status, 'playing')
    assert.equal(forHost.seq, 1)
    assert.equal(forGuest.seq, 1)
    assert.ok(forHost.position >= 42)
    assert.ok(forHost.executeAt > forHost.serverTime)
    assert.equal(forHost.controllerId, hostId)

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.playbackStatus, 'playing')
    assert.equal(room.currentTime, 42)
    assert.equal(room.seq, 1)
  })

  it('rejects playback commands from a member', async () => {
    const { roomId, hostToken, guestToken } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const play = await emitAck(guestSocket, 'playback_play', { position: 10 })
    assert.equal(play.ok, false)
    assert.equal(play.code, 'forbidden')

    const seek = await emitAck(guestSocket, 'playback_seek', { position: 30 })
    assert.equal(seek.ok, false)
    assert.equal(seek.code, 'forbidden')

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.playbackStatus, 'paused')
    assert.equal(room.currentTime, 0)
  })

  it('validates positions and video ids', async () => {
    const { roomId, hostToken } = await createRoomWithVideo()
    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    for (const position of [-5, Number.NaN, 999_999, 'ten', undefined]) {
      const result = await emitAck(hostSocket, 'playback_seek', { position })
      assert.equal(result.ok, false, `position ${position} should be rejected`)
      assert.equal(result.code, 'validation_error')
    }

    const badVideo = await emitAck(hostSocket, 'playback_change_video', {
      videoId: 'https://evil.test/iframe',
    })
    assert.equal(badVideo.ok, false)
    assert.equal(badVideo.code, 'validation_error')

    const noVideoRoom = await createRoomWithVideo()
    const noVideoHost = await connect(newClient())
    await join(noVideoHost, noVideoRoom.roomId, noVideoRoom.hostToken)
    const noVideo = await Room.findByRoomId(noVideoRoom.roomId)
    noVideo.videoId = null
    await noVideo.save()

    const play = await emitAck(noVideoHost, 'playback_play', { position: 1 })
    assert.equal(play.ok, false)
    assert.equal(play.code, 'validation_error')
  })

  it('supports pause and seek with monotonically increasing seq', async () => {
    const { roomId, hostToken } = await createRoomWithVideo()
    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const play = await emitAck(hostSocket, 'playback_play', { position: 50 })
    const pause = await emitAck(hostSocket, 'playback_pause', { position: 55 })
    const seek = await emitAck(hostSocket, 'playback_seek', { position: 100 })

    assert.equal(play.ok, true)
    assert.equal(pause.ok, true)
    assert.equal(seek.ok, true)
    assert.ok(play.data.seq < pause.data.seq)
    assert.ok(pause.data.seq < seek.data.seq)

    assert.equal(pause.data.status, 'paused')
    assert.equal(pause.data.position, 55)
    assert.equal(seek.data.status, 'paused')
    assert.equal(seek.data.position, 100)

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.playbackStatus, 'paused')
    assert.equal(room.currentTime, 100)
  })

  it('changes the video, resets the position and persists it', async () => {
    const { roomId, hostToken } = await createRoomWithVideo()
    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const stateEvent = waitForPlaybackState(hostSocket, (state) => !state.snapshot)
    const ack = await emitAck(hostSocket, 'playback_change_video', {
      videoId: 'jNQXAC9IVRw',
    })
    const state = await stateEvent

    assert.equal(ack.ok, true)
    assert.equal(state.videoId, 'jNQXAC9IVRw')
    assert.equal(state.position, 0)
    assert.equal(state.status, 'paused')

    const room = await Room.findByRoomId(roomId)
    assert.equal(room.videoId, 'jNQXAC9IVRw')
    assert.equal(room.currentTime, 0)
  })

  it('sends a late joiner the current state with the played time compensated', async () => {
    const { roomId, hostToken, guestToken } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)
    await emitAck(hostSocket, 'playback_play', { position: 100 })

    await new Promise((resolve) => setTimeout(resolve, 300))

    const guestSocket = await connect(newClient())
    const snapshotEvent = waitForPlaybackState(guestSocket)
    const guestJoin = await join(guestSocket, roomId, guestToken)
    const snapshot = await snapshotEvent

    assert.equal(guestJoin.ok, true)
    assert.equal(snapshot.snapshot, true)
    assert.equal(snapshot.status, 'playing')
    assert.equal(snapshot.videoId, 'aqz-KE-bpKQ')
    assert.ok(snapshot.position >= 100, `expected >= 100, got ${snapshot.position}`)
    assert.ok(snapshot.executeAt >= snapshot.serverTime)
  })

  it('answers playback_request_state for a joined client', async () => {
    const { roomId, hostToken } = await createRoomWithVideo()
    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const ack = await emitAck(hostSocket, 'playback_request_state', {})
    assert.equal(ack.ok, true)
    assert.equal(ack.data.roomId, roomId)
    assert.equal(ack.data.snapshot, true)
    assert.equal(ack.data.controllerId, ack.data.controllerId)
  })

  it('lets the host hand control to a member and take it back', async () => {
    const { roomId, hostToken, hostId, guestToken, guestId } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const controlEvent = waitForPlaybackState(guestSocket, (state) => state.snapshot === undefined)
    const granted = await emitAck(hostSocket, 'playback_grant_control', { userId: guestId })
    assert.equal(granted.ok, true)
    assert.equal(granted.data.controllerId, guestId)

    const guestPlay = await emitAck(guestSocket, 'playback_play', { position: 12 })
    assert.equal(guestPlay.ok, true)

    const hostPlay = await emitAck(hostSocket, 'playback_play', { position: 20 })
    assert.equal(hostPlay.ok, false)
    assert.equal(hostPlay.code, 'forbidden')

    const reclaimed = await emitAck(hostSocket, 'playback_grant_control', { userId: hostId })
    assert.equal(reclaimed.ok, true)
    assert.equal(reclaimed.data.controllerId, hostId)

    const hostPlayAgain = await emitAck(hostSocket, 'playback_play', { position: 21 })
    assert.equal(hostPlayAgain.ok, true)
    // The guest received the broadcast for the controlled play.
    const state = await controlEvent
    assert.equal(state.roomId, roomId)
  })

  it('only the host can transfer playback control', async () => {
    const { roomId, hostToken, guestToken, guestId } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)

    const guestSocket = await connect(newClient())
    await join(guestSocket, roomId, guestToken)

    const result = await emitAck(guestSocket, 'playback_grant_control', { userId: guestId })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'forbidden')

    const unknown = await emitAck(hostSocket, 'playback_grant_control', {
      userId: 'not-a-participant',
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'not_a_participant')
  })

  it('rejects playback events from a socket that has not joined', async () => {
    const socket = await connect(newClient())

    const play = await emitAck(socket, 'playback_play', { position: 1 })
    assert.equal(play.ok, false)
    assert.equal(play.code, 'not_in_room')

    const snapshot = await emitAck(socket, 'playback_request_state', {})
    assert.equal(snapshot.ok, false)
    assert.equal(snapshot.code, 'not_in_room')
  })

  it('broadcasts a heartbeat while a room is playing', async () => {
    const { roomId, hostToken } = await createRoomWithVideo()

    const hostSocket = await connect(newClient())
    await join(hostSocket, roomId, hostToken)
    await emitAck(hostSocket, 'playback_play', { position: 5 })

    const heartbeat = await waitForPlaybackState(hostSocket, (state) => state.heartbeat === true, 6000)
    assert.equal(heartbeat.status, 'playing')
    assert.ok(heartbeat.seq >= 1)
    assert.equal(heartbeat.roomId, roomId)
  })
})
