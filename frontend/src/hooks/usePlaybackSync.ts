import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { VideoPlayerHandle } from '../components/VideoPlayer'
import {
  acquireWatchPartySocket,
  releaseWatchPartySocket,
} from '../socket/socket'
import type {
  ControlChangedPayload,
  PlaybackStatePayload,
  SocketResult,
  WatchPartySocket,
} from '../socket/socket'
import type { PlaybackStatus } from '../types/room'

/** Drift tiers (seconds): ignore → nudge playbackRate → hard seek. */
const SOFT_DRIFT_SECONDS = 0.15
const HARD_DRIFT_SECONDS = 0.9
const RATE_STEP = 0.05
const RATE_RESET_MS = 4000
const CLOCK_SAMPLES = 5
const CLOCK_SAMPLE_GAP_MS = 150
const CLOCK_REFRESH_MS = 30_000
const MAX_SCHEDULE_MS = 3000
const GESTURE_CHECK_MS = 2500

interface UsePlaybackSyncArgs {
  roomId: string
  initialVideoId: string | null
  canControl: boolean
  playerRef: RefObject<VideoPlayerHandle | null>
}

export interface UsePlaybackSyncResult {
  videoId: string | null
  controllerId: string | null
  status: PlaybackStatus
  canControl: boolean
  driftMs: number | null
  seq: number
  needsGesture: boolean
  error: string | null
  onPlayerReady: () => void
  onPlayerStateChange: (payload: { state: number }) => void
  onPlayerEnded: () => void
  onTimeUpdate: (payload: { currentTime: number; duration: number }) => void
  requestPlay: () => void
  requestPause: () => void
  requestSeek: (seconds: number) => void
  requestChangeVideo: (videoId: string) => void
  enablePlayback: () => void
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Connects the room's YouTube player to the server-authoritative playback
 * state.
 *
 * - The controller's controls emit commands; the server answers with a new
 *   `seq` + `executeAt` and broadcasts, so every client applies the same state.
 * - Remote updates are applied only (never re-emitted): no feedback loops.
 * - Stale states (`seq` / serverTime) are ignored.
 * - Late joiners get a snapshot and are corrected by 3 s heartbeats.
 */
export function usePlaybackSync({
  roomId,
  initialVideoId,
  canControl,
  playerRef,
}: UsePlaybackSyncArgs): UsePlaybackSyncResult {
  const socketRef = useRef<WatchPartySocket | null>(null)
  const disposedRef = useRef(false)
  const latestRef = useRef<PlaybackStatePayload | null>(null)
  const seqRef = useRef(-1)
  const appliedSeqRef = useRef(-1)
  const lastServerTimeRef = useRef(0)
  const videoIdRef = useRef<string | null>(initialVideoId)
  const pendingRef = useRef<PlaybackStatePayload | null>(null)
  const offsetRef = useRef(0)
  const scheduleRef = useRef<number | null>(null)
  const rateResetRef = useRef<number | null>(null)
  const driftStampRef = useRef(0)
  const gestureTimerRef = useRef<number | null>(null)
  const seekGraceUntilRef = useRef(0)
  const playRetryTimerRef = useRef<number | null>(null)

  const [videoId, setVideoId] = useState<string | null>(initialVideoId)
  const [controllerId, setControllerId] = useState<string | null>(null)
  const [status, setStatus] = useState<PlaybackStatus>('paused')
  const [driftMs, setDriftMs] = useState<number | null>(null)
  const [seq, setSeq] = useState(0)
  const [needsGesture, setNeedsGesture] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const serverNow = useCallback(() => Date.now() + offsetRef.current, [])

  const clearRateTimer = useCallback(() => {
    if (rateResetRef.current !== null) {
      window.clearTimeout(rateResetRef.current)
      rateResetRef.current = null
    }
  }, [])

  const setRate = useCallback(
    (rate: number) => {
      playerRef.current?.setPlaybackRate?.(rate)
    },
    [playerRef],
  )

  const scheduleRateReset = useCallback(() => {
    clearRateTimer()
    rateResetRef.current = window.setTimeout(() => {
      rateResetRef.current = null
      setRate(1)
    }, RATE_RESET_MS)
  }, [clearRateTimer, setRate])

  const checkAutoplay = useCallback(() => {
    if (gestureTimerRef.current !== null) window.clearTimeout(gestureTimerRef.current)
    gestureTimerRef.current = window.setTimeout(() => {
      gestureTimerRef.current = null
      const player = playerRef.current
      if (!player) return
      const state = player.getPlayerState()
      const expectedPlaying = latestRef.current?.status === 'playing'
      // 1 = playing, 3 = buffering
      if (expectedPlaying && state !== 1 && state !== 3) {
        // Try calling play once more before showing user gesture banner
        player.play()
        const retryTimer = window.setTimeout(() => {
          const secondState = player.getPlayerState()
          setNeedsGesture(Boolean(expectedPlaying) && secondState !== 1 && secondState !== 3)
        }, 1200)
        gestureTimerRef.current = retryTimer
      } else {
        setNeedsGesture(false)
      }
    }, GESTURE_CHECK_MS)
  }, [playerRef])

  /** Applies one state to the local player (never emits anything). */
  const applyToPlayer = useCallback(
    (payload: PlaybackStatePayload) => {
      if (payload.seq < appliedSeqRef.current) return
      const player = playerRef.current
      if (!player || (typeof player.isReady === 'function' && !player.isReady())) {
        pendingRef.current = payload
        return
      }

      appliedSeqRef.current = payload.seq
      const expected =
        payload.status === 'playing'
          ? payload.position + Math.max(0, (serverNow() - payload.serverTime) / 1000)
          : payload.position
      const local = player.getCurrentTime()
      const drift = local - expected
      const isCommand = !payload.heartbeat && !payload.snapshot

      // Hard seek if drift is large, or if an explicit command arrived and position changed noticeably
      const shouldHardSeek =
        Math.abs(drift) > HARD_DRIFT_SECONDS || (isCommand && Math.abs(drift) > 0.4)

      if (shouldHardSeek) {
        seekGraceUntilRef.current = Date.now() + 2000
        player.seekTo(Math.max(0, expected))
        setRate(1)
        clearRateTimer()
      } else if (payload.status === 'playing' && Math.abs(drift) > SOFT_DRIFT_SECONDS) {
        setRate(drift > 0 ? 1 - RATE_STEP : 1 + RATE_STEP)
        scheduleRateReset()
      }

      if (payload.status === 'playing') {
        player.play()
        if (playRetryTimerRef.current !== null) {
          window.clearTimeout(playRetryTimerRef.current)
        }
        // If an async seek was issued, ensure play is re-confirmed once seeking buffers
        playRetryTimerRef.current = window.setTimeout(() => {
          playRetryTimerRef.current = null
          if (latestRef.current?.status === 'playing') {
            const p = playerRef.current
            if (p && p.getPlayerState() !== 1 && p.getPlayerState() !== 3) {
              p.play()
            }
          }
        }, 400)
        checkAutoplay()
      } else {
        if (playRetryTimerRef.current !== null) {
          window.clearTimeout(playRetryTimerRef.current)
          playRetryTimerRef.current = null
        }
        player.pause()
        setRate(1)
        clearRateTimer()
        setNeedsGesture(false)
      }

      setDriftMs(Math.round(drift * 1000))
      driftStampRef.current = Date.now()
    },
    [clearRateTimer, checkAutoplay, playerRef, scheduleRateReset, serverNow, setRate],
  )

  const scheduleApply = useCallback(
    (payload: PlaybackStatePayload) => {
      if (scheduleRef.current !== null) {
        window.clearTimeout(scheduleRef.current)
        scheduleRef.current = null
      }

      const wait = Math.min(Math.max(payload.executeAt - serverNow(), 0), MAX_SCHEDULE_MS)
      if (wait < 20) {
        applyToPlayer(payload)
        return
      }

      scheduleRef.current = window.setTimeout(() => {
        scheduleRef.current = null
        applyToPlayer(payload)
      }, wait)
    },
    [applyToPlayer, serverNow],
  )

  const handleRemoteState = useCallback(
    (payload: PlaybackStatePayload) => {
      if (disposedRef.current) return
      if (payload.roomId !== roomId) return
      if (payload.seq < seqRef.current) return
      if (payload.seq === seqRef.current && payload.serverTime < lastServerTimeRef.current) {
        return
      }

      seqRef.current = payload.seq
      lastServerTimeRef.current = payload.serverTime
      latestRef.current = payload
      setSeq(payload.seq)
      setControllerId(payload.controllerId)
      setStatus(payload.status)

      if (payload.videoId !== videoIdRef.current) {
        videoIdRef.current = payload.videoId
        setVideoId(payload.videoId)
        pendingRef.current = payload
        return
      }

      scheduleApply(payload)
    },
    [roomId, scheduleApply],
  )

  const handleRemoteRef = useRef(handleRemoteState)
  useEffect(() => {
    handleRemoteRef.current = handleRemoteState
  }, [handleRemoteState])

  const syncClock = useCallback(async () => {
    const socket = socketRef.current
    if (!socket?.connected) return

    let best: number | null = null
    let bestRtt = Infinity

    for (let sample = 0; sample < CLOCK_SAMPLES; sample += 1) {
      if (disposedRef.current || !socket.connected) break

      const sentAt = Date.now()
      const serverTime = await new Promise<number | null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), 2000)
        socket.emit('clock_ping', {}, (result) => {
          window.clearTimeout(timer)
          resolve(result.ok ? result.data.serverTime : null)
        })
      })
      const receivedAt = Date.now()
      const rtt = receivedAt - sentAt

      if (serverTime !== null && rtt < bestRtt) {
        bestRtt = rtt
        best = serverTime - (sentAt + receivedAt) / 2
      }

      await delay(CLOCK_SAMPLE_GAP_MS)
    }

    if (!disposedRef.current && best !== null) offsetRef.current = best
  }, [])

  const requestSnapshot = useCallback(() => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('playback_request_state', {}, (result) => {
      if (result.ok) handleRemoteRef.current(result.data)
    })
  }, [])

  const report = useCallback((result: SocketResult<unknown>) => {
    if (result.ok) setError(null)
    else setError(result.message)
  }, [])

  const requestPlay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    socketRef.current?.emit('playback_play', { position: player.getCurrentTime() }, report)
  }, [playerRef, report])

  const requestPause = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    socketRef.current?.emit('playback_pause', { position: player.getCurrentTime() }, report)
  }, [playerRef, report])

  const requestSeek = useCallback(
    (seconds: number) => {
      socketRef.current?.emit('playback_seek', { position: seconds }, report)
    },
    [report],
  )

  const requestChangeVideo = useCallback(
    (videoIdToLoad: string) => {
      socketRef.current?.emit('playback_change_video', { videoId: videoIdToLoad }, report)
    },
    [report],
  )

  const onPlayerReady = useCallback(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) {
      applyToPlayer(pending)
    } else if (latestRef.current) {
      applyToPlayer(latestRef.current)
    } else {
      requestSnapshot()
    }
  }, [applyToPlayer, requestSnapshot])

  const onPlayerEnded = useCallback(() => {
    if (canControl) {
      const player = playerRef.current
      const duration = player?.getDuration() ?? 0
      socketRef.current?.emit('playback_ended', { position: duration }, report)
    }
  }, [canControl, playerRef, report])

  const onPlayerStateChange = useCallback(
    ({ state }: { state: number }) => {
      const latest = latestRef.current
      if (!latest) return

      if (latest.status === 'playing') {
        if (state === 1 || state === 3) {
          setNeedsGesture(false)
          if (gestureTimerRef.current !== null) {
            window.clearTimeout(gestureTimerRef.current)
            gestureTimerRef.current = null
          }
        } else if (state === 2 || state === 5 || state === -1) {
          // If seek or buffering finished and YouTube left the player paused while room is playing,
          // auto-resume immediately!
          const p = playerRef.current
          if (p) {
            p.play()
          }
        }
      } else if (latest.status === 'paused') {
        if (state === 1 || state === 3) {
          const p = playerRef.current
          if (p) {
            p.pause()
          }
        }
      }
    },
    [playerRef],
  )

  const onTimeUpdate = useCallback(
    ({ currentTime }: { currentTime: number }) => {
      // If we recently initiated a seek, give the player 2 seconds to buffer without interfering
      if (Date.now() < seekGraceUntilRef.current) return

      const latest = latestRef.current
      if (!latest || latest.status !== 'playing') return

      const player = playerRef.current
      if (!player) return

      const expected = latest.position + Math.max(0, (serverNow() - latest.serverTime) / 1000)
      const drift = currentTime - expected

      if (Date.now() - driftStampRef.current > 500) {
        driftStampRef.current = Date.now()
        setDriftMs(Math.round(drift * 1000))
      }

      if (Math.abs(drift) > HARD_DRIFT_SECONDS) {
        seekGraceUntilRef.current = Date.now() + 2000
        player.seekTo(Math.max(0, expected))
        setRate(1)
        clearRateTimer()
      } else if (Math.abs(drift) > SOFT_DRIFT_SECONDS) {
        setRate(drift > 0 ? 1 - RATE_STEP : 1 + RATE_STEP)
        scheduleRateReset()
      }
    },
    [clearRateTimer, playerRef, scheduleRateReset, serverNow, setRate],
  )

  const enablePlayback = useCallback(() => {
    setNeedsGesture(false)
    const latest = latestRef.current
    const player = playerRef.current
    if (!player) return
    player.play()
    if (latest) applyToPlayer(latest)
  }, [applyToPlayer, playerRef])

  useEffect(() => {
    disposedRef.current = false
    const socket = acquireWatchPartySocket()
    socketRef.current = socket

    const onState = (payload: PlaybackStatePayload) => handleRemoteState(payload)
    const onControlChanged = (payload: ControlChangedPayload) => {
      if (disposedRef.current || payload.roomId !== roomId) return
      setControllerId(payload.controllerId)
    }
    const onConnect = () => {
      if (disposedRef.current) return
      void syncClock()
      requestSnapshot()
    }

    socket.on('playback_state', onState)
    socket.on('control_changed', onControlChanged)
    socket.on('connect', onConnect)

    if (socket.connected) {
      void syncClock()
      requestSnapshot()
    }

    const clockTimer = window.setInterval(() => {
      void syncClock()
    }, CLOCK_REFRESH_MS)

    return () => {
      disposedRef.current = true
      socket.off('playback_state', onState)
      socket.off('control_changed', onControlChanged)
      socket.off('connect', onConnect)
      window.clearInterval(clockTimer)
      if (scheduleRef.current !== null) window.clearTimeout(scheduleRef.current)
      if (rateResetRef.current !== null) window.clearTimeout(rateResetRef.current)
      if (gestureTimerRef.current !== null) window.clearTimeout(gestureTimerRef.current)
      if (playRetryTimerRef.current !== null) window.clearTimeout(playRetryTimerRef.current)
      scheduleRef.current = null
      rateResetRef.current = null
      gestureTimerRef.current = null
      playRetryTimerRef.current = null
      socketRef.current = null
      releaseWatchPartySocket()
    }
  }, [handleRemoteState, requestSnapshot, roomId, syncClock])

  return {
    videoId,
    controllerId,
    status,
    canControl,
    driftMs,
    seq,
    needsGesture,
    error,
    onPlayerReady,
    onPlayerStateChange,
    onPlayerEnded,
    onTimeUpdate,
    requestPlay,
    requestPause,
    requestSeek,
    requestChangeVideo,
    enablePlayback,
  }
}
