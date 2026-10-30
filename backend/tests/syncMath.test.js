import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EXECUTE_WINDOW_MS,
  buildPlaybackState,
  controllerOf,
  isPlaybackController,
  roundPosition,
} from '../src/sockets/playback.js'
import { YOUTUBE_ID_PATTERN } from '../src/models/Room.js'

describe('Playback Sync Math & Extrapolation Logic', () => {
  it('rounds positions to 3 decimal places', () => {
    assert.equal(roundPosition(42.12345), 42.123)
    assert.equal(roundPosition(10), 10)
    assert.equal(roundPosition(0.0001), 0)
    assert.equal(roundPosition(0.0009), 0.001)
  })

  it('keeps paused room position constant regardless of elapsed time', () => {
    const updatedAt = Date.now() - 50_000 // 50 seconds ago
    const room = {
      roomId: 'TEST01',
      videoId: 'aqz-KE-bpKQ',
      playbackStatus: 'paused',
      currentTime: 30,
      playbackUpdatedAt: new Date(updatedAt),
      hostId: 'host-1',
      controllerId: 'host-1',
      seq: 2,
    }

    const now = Date.now()
    const state = buildPlaybackState(room, now)

    assert.equal(state.status, 'paused')
    assert.equal(state.position, 30) // Does not extrapolate when paused
    assert.equal(state.seq, 2)
    assert.equal(state.executeAt, now + EXECUTE_WINDOW_MS)
  })

  it('extrapolates position accurately for playing rooms', () => {
    const elapsedSeconds = 12.345
    const now = Date.now()
    const updatedAt = now - elapsedSeconds * 1000

    const room = {
      roomId: 'TEST02',
      videoId: 'aqz-KE-bpKQ',
      playbackStatus: 'playing',
      currentTime: 100,
      playbackUpdatedAt: new Date(updatedAt),
      hostId: 'host-1',
      controllerId: 'host-1',
      seq: 5,
    }

    const state = buildPlaybackState(room, now)

    assert.equal(state.status, 'playing')
    assert.equal(state.position, 112.345)
    assert.equal(state.seq, 5)
  })

  it('identifies playback controller correctly', () => {
    const defaultRoom = { hostId: 'host-123', controllerId: null }
    assert.equal(controllerOf(defaultRoom), 'host-123')
    assert.equal(isPlaybackController(defaultRoom, 'host-123'), true)
    assert.equal(isPlaybackController(defaultRoom, 'guest-456'), false)

    const delegatedRoom = { hostId: 'host-123', controllerId: 'guest-456' }
    assert.equal(controllerOf(delegatedRoom), 'guest-456')
    assert.equal(isPlaybackController(delegatedRoom, 'guest-456'), true)
    assert.equal(isPlaybackController(delegatedRoom, 'host-123'), false)
  })
})

describe('3-Tier Drift Calculation Logic', () => {
  const SOFT_DRIFT = 0.15 // 150 ms
  const HARD_DRIFT = 0.9 // 900 ms

  function classifyDrift(localTime, expectedTime) {
    const drift = localTime - expectedTime
    const absDrift = Math.abs(drift)

    if (absDrift <= SOFT_DRIFT) {
      return { tier: 1, action: 'ignore', drift }
    }
    if (absDrift <= HARD_DRIFT) {
      return {
        tier: 2,
        action: 'nudge_rate',
        suggestedRate: drift > 0 ? 0.95 : 1.05,
        drift,
      }
    }
    return { tier: 3, action: 'hard_seek', target: expectedTime, drift }
  }

  it('ignores minor drift under 150 ms (Tier 1)', () => {
    const result1 = classifyDrift(42.05, 42.0)
    assert.equal(result1.tier, 1)
    assert.equal(result1.action, 'ignore')

    const result2 = classifyDrift(41.9, 42.0)
    assert.equal(result2.tier, 1)
    assert.equal(result2.action, 'ignore')
  })

  it('nudges playback rate for drift between 150 ms and 900 ms (Tier 2)', () => {
    // Local player is ahead -> slow down to 0.95x
    const ahead = classifyDrift(42.3, 42.0) // +300 ms
    assert.equal(ahead.tier, 2)
    assert.equal(ahead.action, 'nudge_rate')
    assert.equal(ahead.suggestedRate, 0.95)

    // Local player is behind -> speed up to 1.05x
    const behind = classifyDrift(41.6, 42.0) // -400 ms
    assert.equal(behind.tier, 2)
    assert.equal(behind.action, 'nudge_rate')
    assert.equal(behind.suggestedRate, 1.05)
  })

  it('triggers hard seek for drift exceeding 900 ms (Tier 3)', () => {
    const largeDrift = classifyDrift(50.0, 42.0) // +8.0 seconds ahead
    assert.equal(largeDrift.tier, 3)
    assert.equal(largeDrift.action, 'hard_seek')
    assert.equal(largeDrift.target, 42.0)

    const largeLag = classifyDrift(35.0, 42.0) // -7.0 seconds behind
    assert.equal(largeLag.tier, 3)
    assert.equal(largeLag.action, 'hard_seek')
    assert.equal(largeLag.target, 42.0)
  })
})

describe('Clock Offset & RTT Estimation Logic', () => {
  it('calculates clock offset accurately with symmetric network delay', () => {
    const clientSentAt = 1000
    const oneWayLatency = 25
    const serverTimestamp = 2000 // Server is ahead by 975ms relative to clientSentAt
    const clientReceivedAt = clientSentAt + oneWayLatency * 2 // 1050

    const rtt = clientReceivedAt - clientSentAt // 50ms
    const estimatedOffset = serverTimestamp - (clientSentAt + clientReceivedAt) / 2
    // Midpoint is (1000 + 1050) / 2 = 1025.
    // Offset is 2000 - 1025 = 975ms.
    assert.equal(rtt, 50)
    assert.equal(estimatedOffset, 975)
  })
})

describe('Validation Constraints', () => {
  it('strictly validates YouTube video IDs', () => {
    assert.equal(YOUTUBE_ID_PATTERN.test('aqz-KE-bpKQ'), true)
    assert.equal(YOUTUBE_ID_PATTERN.test('dQw4w9WgXcQ'), true)
    assert.equal(YOUTUBE_ID_PATTERN.test('12345678901'), true)

    assert.equal(YOUTUBE_ID_PATTERN.test('too-short'), false)
    assert.equal(YOUTUBE_ID_PATTERN.test('way-too-long-video-id'), false)
    assert.equal(YOUTUBE_ID_PATTERN.test('https://youtube.com/watch?v=123'), false)
    assert.equal(YOUTUBE_ID_PATTERN.test('<script>alert(1)</script>'), false)
    assert.equal(YOUTUBE_ID_PATTERN.test('bad!chars?$'), false)
  })
})
