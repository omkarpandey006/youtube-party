import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { MongoMemoryServer } from 'mongodb-memory-server'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { connectDB, disconnectDB } from '../src/config/db.js'
import Room from '../src/models/Room.js'
import {
  ROOM_CODE_ALPHABET,
  generateRoomCode,
} from '../src/utils/roomCode.js'

let mongo
let app

before(async () => {
  mongo = await MongoMemoryServer.create()
  await connectDB({ uri: mongo.getUri(), quiet: true })
  app = createApp()
})

after(async () => {
  await Room.deleteMany({})
  await disconnectDB()
  await mongo.stop()
})

beforeEach(async () => {
  await Room.deleteMany({})
})

async function createRoom(overrides = {}) {
  return request(app)
    .post('/api/rooms')
    .send({ hostName: 'Host User', ...overrides })
}

describe('GET /api/health', () => {
  it('reports the service and database as connected', async () => {
    const response = await request(app).get('/api/health')

    assert.equal(response.status, 200)
    assert.equal(response.body.ok, undefined) // health has its own shape
    assert.equal(response.body.status, 'ok')
    assert.equal(response.body.database.state, 'connected')
  })
})

describe('POST /api/rooms', () => {
  it('creates a room with the creator as host', async () => {
    const response = await createRoom({ hostName: '  Omkar  ' })

    assert.equal(response.status, 201)
    assert.equal(response.body.ok, true)

    const { room, hostId } = response.body.data
    assert.match(room.roomId, /^[A-Z0-9]{6}$/)
    assert.equal(room.videoId, null)
    assert.equal(room.playbackStatus, 'paused')
    assert.equal(room.currentTime, 0)
    assert.equal(room.hostId, hostId)
    assert.equal(room.participants.length, 1)
    assert.equal(room.participants[0].userId, hostId)
    assert.equal(room.participants[0].name, 'Omkar')
    assert.equal(room.participants[0].role, 'host')
    assert.ok(room.createdAt)
    assert.ok(room.updatedAt)
  })

  it('accepts an optional videoId and hostId', async () => {
    const response = await createRoom({
      hostId: 'my-user-id',
      videoId: 'dQw4w9WgXcQ',
    })

    assert.equal(response.status, 201)
    assert.equal(response.body.data.hostId, 'my-user-id')
    assert.equal(response.body.data.room.videoId, 'dQw4w9WgXcQ')
  })

  it('never exposes internal fields', async () => {
    const response = await createRoom()

    assert.equal(response.body.data.room.__v, undefined)
    assert.equal(response.body.data.room.participants[0].socketId, undefined)
  })

  it('rejects a missing hostName', async () => {
    const response = await request(app).post('/api/rooms').send({})

    assert.equal(response.status, 400)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.code, 'validation_error')
    assert.ok(Array.isArray(response.body.details))
    assert.ok(response.body.details.some((detail) => detail.field === 'hostName'))
    assert.equal(response.body.stack, undefined)
    assert.equal(response.body.debugStack, undefined)
  })

  it('rejects an invalid videoId', async () => {
    const response = await createRoom({ videoId: 'too-short' })

    assert.equal(response.status, 400)
    assert.ok(response.body.details.some((detail) => detail.field === 'videoId'))
  })

  it('rejects unknown fields', async () => {
    const response = await createRoom({ isAdmin: true })

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'validation_error')
  })

  it('rejects malformed JSON', async () => {
    const response = await request(app)
      .post('/api/rooms')
      .set('Content-Type', 'application/json')
      .send('{"hostName": ')

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'invalid_json')
  })
})

describe('GET /api/rooms/:roomId', () => {
  it('returns the room for a lowercase code', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room

    const response = await request(app).get(`/api/rooms/${roomId.toLowerCase()}`)

    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.data.room.roomId, roomId)
  })

  it('returns 404 for an unknown room', async () => {
    const response = await request(app).get('/api/rooms/ZZZZZZ')

    assert.equal(response.status, 404)
    assert.equal(response.body.code, 'not_found')
  })

  it('returns 400 for a malformed room code', async () => {
    const response = await request(app).get('/api/rooms/abc')

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'validation_error')
    assert.ok(response.body.details.some((detail) => detail.field === 'roomId'))
  })
})

describe('POST /api/rooms/:roomId/join', () => {
  it('adds a new participant and generates a userId', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room

    const response = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({ name: 'Guest' })

    assert.equal(response.status, 200)
    assert.equal(response.body.data.joined, true)
    assert.ok(response.body.data.userId)
    assert.equal(response.body.data.room.participants.length, 2)
    assert.equal(
      response.body.data.room.participants[1].role,
      'participant',
    )
  })

  it('is idempotent for an existing userId and updates the name', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room

    await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({ name: 'Guest', userId: 'guest-1' })

    const second = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({ name: 'Guest Renamed', userId: 'guest-1' })

    assert.equal(second.status, 200)
    assert.equal(second.body.data.joined, false)
    assert.equal(second.body.data.room.participants.length, 2)
    assert.equal(second.body.data.room.participants[1].name, 'Guest Renamed')
  })

  it('does not turn the host into a participant', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room
    const { hostId } = created.body.data

    const response = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({ name: 'Host Again', userId: hostId })

    assert.equal(response.status, 200)
    assert.equal(response.body.data.joined, false)
    assert.equal(response.body.data.room.participants.length, 1)
    assert.equal(response.body.data.room.participants[0].role, 'host')
  })

  it('returns 404 when the room does not exist', async () => {
    const response = await request(app)
      .post('/api/rooms/ZZZZZZ/join')
      .send({ name: 'Guest' })

    assert.equal(response.status, 404)
    assert.equal(response.body.code, 'not_found')
  })

  it('rejects a missing name', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room

    const response = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({})

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'validation_error')
  })

  it('returns 409 when the room is full', async () => {
    const created = await createRoom()
    const { roomId } = created.body.data.room

    const room = await Room.findByRoomId(roomId)
    for (let index = 0; index < 19; index += 1) {
      room.participants.push({
        userId: `seed-user-${index}`,
        name: `Seed ${index}`,
        role: 'participant',
        connected: false,
      })
    }
    await room.save()

    const response = await request(app)
      .post(`/api/rooms/${roomId}/join`)
      .send({ name: 'Too Late' })

    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'room_full')
  })
})

describe('room code generator', () => {
  it('produces 6 chars from the safe alphabet', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = generateRoomCode()
      assert.equal(code.length, 6)
      for (const character of code) {
        assert.ok(ROOM_CODE_ALPHABET.includes(character), `unexpected char ${character}`)
      }
    }
  })

  it('does not repeat itself over 2000 generations', () => {
    const codes = new Set()
    for (let index = 0; index < 2000; index += 1) {
      codes.add(generateRoomCode())
    }
    assert.equal(codes.size, 2000)
  })
})

describe('unknown routes', () => {
  it('returns a consistent 404 envelope', async () => {
    const response = await request(app).get('/api/nope')

    assert.equal(response.status, 404)
    assert.deepEqual(Object.keys(response.body).sort(), ['code', 'message', 'ok'])
    assert.equal(response.body.ok, false)
    assert.equal(response.body.code, 'not_found')
  })
})
