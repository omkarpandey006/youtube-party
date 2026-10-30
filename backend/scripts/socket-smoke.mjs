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
  const created = await post('/rooms', { hostName: 'Smoke Host', videoId: 'aqz-KE-bpKQ' })
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

  // --- Phase 6 Playback Synchronization Verification ---
  const pingAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('clock_ping', {}, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('clock_ping returns server timestamp', pingAck.ok === true && typeof pingAck.data?.serverTime === 'number')

  // Host plays video -> guest receives authoritative state
  const guestPlayState = waitForEvent(guest, 'playback_state')
  const hostPlayAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('playback_play', { position: 10.5 }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host playback_play acknowledged', hostPlayAck.ok === true && hostPlayAck.data.status === 'playing')
  const playState = await guestPlayState
  check(
    'guest received playback_state (playing)',
    playState.status === 'playing' && playState.position >= 10.5 && playState.executeAt > playState.serverTime,
  )

  // Unauthorized guest tries to play -> rejected with forbidden
  const unauthorizedPlay = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('playback_play', { position: 12.0 }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('unauthorized guest play rejected with forbidden', unauthorizedPlay.ok === false && unauthorizedPlay.code === 'forbidden')

  // Host seeks video -> guest receives updated position
  const guestSeekState = waitForEvent(guest, 'playback_state')
  const hostSeekAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('playback_seek', { position: 42.0 }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host playback_seek acknowledged', hostSeekAck.ok === true && hostSeekAck.data.position === 42.0)
  const seekState = await guestSeekState
  check('guest received playback_state (seek 42s)', seekState.position === 42.0)

  // Host pauses video -> guest receives paused status
  const guestPauseState = waitForEvent(guest, 'playback_state')
  const hostPauseAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('playback_pause', { position: 42.0 }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host playback_pause acknowledged', hostPauseAck.ok === true && hostPauseAck.data.status === 'paused')
  const pauseState = await guestPauseState
  check('guest received playback_state (paused)', pauseState.status === 'paused')

  // Host changes video -> guest receives new videoId
  const guestChangeState = waitForEvent(guest, 'playback_state')
  const hostChangeAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('playback_change_video', { videoId: 'dQw4w9WgXcQ' }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host playback_change_video acknowledged', hostChangeAck.ok === true && hostChangeAck.data.videoId === 'dQw4w9WgXcQ')
  const changeState = await guestChangeState
  check('guest received playback_state (new videoId & reset 0s)', changeState.videoId === 'dQw4w9WgXcQ' && changeState.position === 0)

  // --- Phase 7 Roles & Permissions Verification ---
  // Guest (participant) calls host-only assign_role -> forbidden
  const forbiddenAssign = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('assign_role', { userId: guestId, role: 'moderator' }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('guest assign_role rejected with forbidden', forbiddenAssign.ok === false && forbiddenAssign.code === 'forbidden')

  // Guest (participant) tries to remove someone -> forbidden
  const forbiddenRemove = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('remove_participant', { userId: hostJoin.data.self.userId }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('guest remove_participant rejected with forbidden', forbiddenRemove.ok === false && forbiddenRemove.code === 'forbidden')

  // Host promotes guest to moderator
  const guestRoleAssignedEvent = waitForEvent(guest, 'role_assigned')
  const hostAssignAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('assign_role', { userId: guestId, role: 'moderator' }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host assign_role (moderator) acknowledged', hostAssignAck.ok === true && hostAssignAck.data.role === 'moderator')
  const roleAssignedPayload = await guestRoleAssignedEvent
  check('guest received role_assigned (moderator)', roleAssignedPayload.userId === guestId && roleAssignedPayload.role === 'moderator')

  // Moderator CAN now control playback (Moderator plays video)
  const hostModPlayEvent = waitForEvent(host, 'playback_state')
  const modPlayAck = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('playback_play', { position: 15.0 }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('moderator playback_play accepted', modPlayAck.ok === true && modPlayAck.data.status === 'playing')
  const hostReceivedModPlay = await hostModPlayEvent
  check('host received playback_state from moderator play', hostReceivedModPlay.status === 'playing')

  // Moderator tries to assign role -> forbidden (only host can assign roles)
  const modAssignForbidden = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('assign_role', { userId: guestId, role: 'participant' }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('moderator assign_role rejected with forbidden', modAssignForbidden.ok === false && modAssignForbidden.code === 'forbidden')

  // Moderator tries to remove someone -> forbidden (only host can remove participants)
  const modRemoveForbidden = await new Promise((resolve, reject) => {
    guest.timeout(4000).emit('remove_participant', { userId: hostJoin.data.self.userId }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('moderator remove_participant rejected with forbidden', modRemoveForbidden.ok === false && modRemoveForbidden.code === 'forbidden')

  // Host transfers host status to guest
  const guestHostTransferredEvent = waitForEvent(guest, 'host_transferred')
  const hostTransferAck = await new Promise((resolve, reject) => {
    host.timeout(4000).emit('transfer_host', { userId: guestId }, (err, res) => (err ? reject(err) : resolve(res)))
  })
  check('host transfer_host acknowledged', hostTransferAck.ok === true && hostTransferAck.data.hostId === guestId)
  const hostTransferredPayload = await guestHostTransferredEvent
  check('guest received host_transferred event', hostTransferredPayload.newHostId === guestId)

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
