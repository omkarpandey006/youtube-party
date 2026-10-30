/**
 * Database integration check.
 *
 * Uses MONGODB_URI when it is set. Otherwise it starts a throwaway in-memory
 * MongoDB (mongodb-memory-server) so the schema and connection code can still
 * be verified without Atlas credentials.
 *
 * Usage: npm run verify:db
 */
import mongoose from 'mongoose'
import { connectDB, disconnectDB, getDatabaseStatus } from '../src/config/db.js'
import { env } from '../src/config/env.js'
import Room from '../src/models/Room.js'
import { redactMongoUri } from '../src/utils/redact.js'

const results = []
let memoryServer = null

function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function expectValidationError(name, payload, field) {
  try {
    await new Room(payload).validate()
    record(name, false, 'expected a validation error, got none')
  } catch (error) {
    const hasFieldError = Boolean(error.errors?.[field])
    record(name, hasFieldError, hasFieldError ? `rejected "${field}"` : error.message)
  }
}

function validRoom(overrides = {}) {
  return {
    roomId: 'ABC123',
    videoId: 'dQw4w9WgXcQ',
    playbackStatus: 'paused',
    currentTime: 42.5,
    hostId: 'user-host-1',
    participants: [
      { userId: 'user-host-1', name: 'Host', role: 'host', connected: true },
      { userId: 'user-guest-1', name: 'Guest', role: 'participant', connected: true },
    ],
    ...overrides,
  }
}

async function resolveUri() {
  if (env.mongodbUri) {
    console.log(`Target: ${redactMongoUri(env.mongodbUri)} (from MONGODB_URI)`)
    return { uri: env.mongodbUri, kind: 'configured MongoDB' }
  }

  console.log('MONGODB_URI is not set — starting an in-memory MongoDB for this check.')
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  memoryServer = await MongoMemoryServer.create()
  console.log(`Target: ${redactMongoUri(memoryServer.getUri())} (temporary, deleted afterwards)`)
  return { uri: memoryServer.getUri(), kind: 'in-memory MongoDB (test only)' }
}

async function run() {
  const { uri, kind } = await resolveUri()

  await connectDB({ uri, quiet: true })
  record('connects using the shared connectDB() helper', mongoose.connection.readyState === 1, kind)

  const status = getDatabaseStatus()
  record('getDatabaseStatus() reports connected', status.state === 'connected', `db: ${status.name}`)

  await Room.init()
  const indexes = await Room.collection.indexes()
  record(
    'unique index exists on roomId',
    indexes.some((index) => index.unique === true && index.key.roomId === 1),
  )

  await Room.deleteMany({})

  const created = await Room.create(validRoom())
  record('creates a valid room', Boolean(created.id))
  record('timestamps are set', Boolean(created.createdAt && created.updatedAt))
  record('defaults applied', created.playbackStatus === 'paused' && created.currentTime === 42.5)

  const found = await Room.findByRoomId('abc123')
  record('findByRoomId() normalises lowercase codes', found?.roomId === 'ABC123')

  try {
    await Room.create(validRoom())
    record('rejects a duplicate roomId', false, 'duplicate was accepted')
  } catch (error) {
    record('rejects a duplicate roomId', error.code === 11000, `code ${error.code}`)
  }

  await expectValidationError('rejects an invalid videoId', validRoom({ roomId: 'ABC124', videoId: 'too-short' }), 'videoId')
  await expectValidationError(
    'rejects a negative currentTime',
    validRoom({ roomId: 'ABC125', currentTime: -5 }),
    'currentTime',
  )
  await expectValidationError(
    'rejects an unknown playbackStatus',
    validRoom({ roomId: 'ABC126', playbackStatus: 'buffering' }),
    'playbackStatus',
  )
  await expectValidationError(
    'rejects a mismatched hostId',
    validRoom({ roomId: 'ABC127', hostId: 'someone-else' }),
    'hostId',
  )
  await expectValidationError(
    'rejects a room whose participants have no host',
    validRoom({
      roomId: 'ABC128',
      participants: [{ userId: 'user-host-1', name: 'Host', role: 'participant' }],
    }),
    'participants',
  )

  await Room.deleteMany({})

  const failed = results.filter((result) => !result.ok)
  console.log('')
  console.log(`${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    console.log('Failed checks:')
    failed.forEach((result) => console.log(`  - ${result.name}`))
  }

  return failed.length === 0
}

let success = false

try {
  success = await run()
} catch (error) {
  console.error(`\nDatabase check could not complete: ${error.message}`)
  if (error.cause?.message) console.error(`Cause: ${error.cause.message}`)
} finally {
  try {
    await Room.deleteMany({})
    await disconnectDB()
  } catch {
    // ignore cleanup errors
  }
  if (memoryServer) await memoryServer.stop()
}

process.exit(success ? 0 : 1)
