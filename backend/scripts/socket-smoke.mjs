/**
 * Manual two-client smoke test for the Socket.IO presence layer.
 *
 * Requires a running backend (npm run dev). It uses the public REST + socket
 * APIs only — there is no bypass or development backdoor.
 *
 *   npm run smoke:socket
 *   BASE_URL=http://localhost:5000 npm run smoke:socket   (bash)
 *   $env:BASE_URL='http://localhost:5000'; npm run smoke:socket   (PowerShell)
 */
import { io } from 'socket.io-client'
import { connectDB, disconnectDB } from '../src/config/db.js'
import Room from '../src/models/Room.js'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5000'
const API = `${BASE_URL}/api`

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

function waitForEvent(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

function connectClient() {
  return io(BASE_URL, {
    autoConnect: false,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  })
}

function joinRoom(socket, roomId, token, extra = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit('join_room', { roomId, token, ...extra }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

let roomId = null
let host
let guest

try {
  const created = await post('/rooms', { hostName: 'Smoke Host' })
  check('REST create room', created.status === 201, `HTTP ${created.status}`)
  roomId = created.body.data?.room?.roomId
  const hostToken = created.body.data?.token
  check('REST returns a participant token', typeof hostToken === 'string' && hostToken.includes('.'))

  const joined = await post(`/rooms/${roomId}/join`, { name: 'Smoke Guest' })
  check('REST join room', joined.status === 200, `HTTP ${joined.status}`)
  const guestToken = joined.body.data?.token
  const guestId = joined.body.data?.userId

  host = connectClient()
  const hostConnected = waitForEvent(host, 'connect')
  host.connect()
  await hostConnected
  const hostJoin = await joinRoom(host, roomId, hostToken)
  check('host socket joined', hostJoin.ok === true, hostJoin.ok ? 'room_state received' : hostJoin.code)
  check('host role is server-assigned', hostJoin.ok && hostJoin.data.self.role === 'host')

  guest = connectClient()
  const guestConnected = waitForEvent(guest, 'connect')
  guest.connect()
  await guestConnected

  const joinedEvent = waitForEvent(host, 'participant_joined')
  const guestJoin = await joinRoom(guest, roomId, guestToken, { role: 'host', socketId: 'spoofed' })
  check('guest socket joined', guestJoin.ok === true, guestJoin.ok ? '' : guestJoin.code)

  const event = await joinedEvent
  check('host received participant_joined', event.participant?.userId === guestId)
  check(
    'client-supplied role was ignored',
    guestJoin.ok && guestJoin.data.self.role === 'participant' && event.participant.role === 'participant',
  )

  const leftEvent = waitForEvent(host, 'participant_left')
  guest.disconnect()
  guest = null
  const left = await leftEvent
  check('host received participant_left', left.userId === guestId)

  const roomAfter = await fetch(`${API}/rooms/${roomId}`).then((response) => response.json())
  const storedGuest = roomAfter.data?.room?.participants?.find(
    (participant) => participant.userId === guestId,
  )
  check('guest marked disconnected in MongoDB', storedGuest?.connected === false)
} catch (error) {
  check('smoke run completed without exceptions', false, error.message)
} finally {
  host?.disconnect()
  guest?.disconnect()

  if (roomId) {
    try {
      await connectDB({ quiet: true })
      await Room.deleteOne({ roomId })
      await disconnectDB()
      console.log(`cleanup: removed test room ${roomId}`)
    } catch (error) {
      console.log(`cleanup failed for ${roomId}: ${error.message}`)
    }
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
