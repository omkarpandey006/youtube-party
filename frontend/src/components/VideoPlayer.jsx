import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { isValidYouTubeVideoId } from '../utils/youtube'
import { loadYouTubeIframeApi } from '../utils/youtubeIframe'

/** Mirrors YT.PlayerState; kept local so the UI does not depend on the global. */
const PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
}

const STATE_LABEL = {
  [PLAYER_STATE.UNSTARTED]: 'Ready',
  [PLAYER_STATE.ENDED]: 'Ended',
  [PLAYER_STATE.PLAYING]: 'Playing',
  [PLAYER_STATE.PAUSED]: 'Paused',
  [PLAYER_STATE.BUFFERING]: 'Buffering…',
  [PLAYER_STATE.CUED]: 'Ready',
}

/** https://developers.google.com/youtube/iframe_api_reference#onError */
const ERROR_MESSAGES = {
  2: 'YouTube rejected this video id.',
  5: 'The HTML5 player could not start this video.',
  100: 'This video is private, removed or otherwise unavailable.',
  101: 'The video owner does not allow embedding. Try another video.',
  150: 'The video owner does not allow embedding. Try another video.',
}

function formatTime(rawSeconds) {
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * Local YouTube player (no cross-user sync yet).
 *
 * The video id is validated before it reaches the embed URL, the iframe is
 * created by the official IFrame API (never from raw user HTML) and the player
 * is destroyed on unmount.
 *
 * Mount it with a `key` equal to the video id when the id can change, so a new
 * video gets a clean player instance.
 */
const VideoPlayer = forwardRef(function VideoPlayer(
  {
    videoId,
    title = 'YouTube video',
    canControl = true,
    onReady,
    onStateChange,
    onTimeUpdate,
    onError,
    onEnded,
    onLocalPlay,
    onUserPlay,
    onUserPause,
    onUserSeek,
  },
  ref,
) {
  const containerRef = useRef(null)
  const playerRef = useRef(null)
  const tickerRef = useRef(null)
  const callbacksRef = useRef({})

  useEffect(() => {
    callbacksRef.current = {
      onReady,
      onStateChange,
      onTimeUpdate,
      onError,
      onEnded,
      onLocalPlay,
      onUserPlay,
      onUserPause,
      onUserSeek,
    }
  })

  const hasVideo = typeof videoId === 'string' && videoId.trim().length > 0
  const normalizedId = isValidYouTubeVideoId(videoId) ? videoId.trim() : null
  const invalidId = hasVideo && !normalizedId

  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [playerState, setPlayerState] = useState(PLAYER_STATE.UNSTARTED)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [seekDraft, setSeekDraft] = useState(null)
  const isReadyRef = useRef(false)

  useImperativeHandle(
    ref,
    () => ({
      play: () => playerRef.current?.playVideo?.(),
      pause: () => playerRef.current?.pauseVideo?.(),
      seekTo: (seconds) => playerRef.current?.seekTo?.(seconds, true),
      getCurrentTime: () => playerRef.current?.getCurrentTime?.() ?? 0,
      getDuration: () => playerRef.current?.getDuration?.() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState?.() ?? PLAYER_STATE.UNSTARTED,
      setPlaybackRate: (rate) => playerRef.current?.setPlaybackRate?.(rate),
      getPlaybackRate: () => playerRef.current?.getPlaybackRate?.() ?? 1,
      isReady: () =>
        Boolean(isReadyRef.current && playerRef.current && typeof playerRef.current.playVideo === 'function'),
    }),
    [],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!normalizedId || !container) return undefined

    let cancelled = false
    const mountNode = document.createElement('div')
    container.replaceChildren(mountNode)

    const stopTicker = () => {
      if (tickerRef.current !== null) {
        window.clearInterval(tickerRef.current)
        tickerRef.current = null
      }
    }

    const startTicker = () => {
      stopTicker()
      tickerRef.current = window.setInterval(() => {
        const player = playerRef.current
        if (!player?.getCurrentTime) return

        const time = player.getCurrentTime() ?? 0
        const total = player.getDuration?.() ?? 0
        setCurrentTime(time)
        setDuration(total)
        callbacksRef.current.onTimeUpdate?.({ currentTime: time, duration: total })
      }, 250)
    }

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return

        const player = new YT.Player(mountNode, {
          videoId: normalizedId,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            enablejsapi: 1,
            origin: typeof window !== 'undefined' ? window.location.origin : undefined,
          },
          events: {
            onReady: (event) => {
              if (cancelled) return
              const iframe = container.querySelector('iframe')
              if (iframe) {
                iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture')
              }
              playerRef.current = event.target
              isReadyRef.current = true
              setStatus('ready')
              setDuration(event.target.getDuration?.() ?? 0)
              startTicker()
              callbacksRef.current.onReady?.({ player: event.target })
            },
            onStateChange: (event) => {
              if (cancelled) return
              setPlayerState(event.data)
              callbacksRef.current.onStateChange?.({ state: event.data })
              if (event.data === PLAYER_STATE.ENDED) {
                callbacksRef.current.onEnded?.()
              }
            },
            onError: (event) => {
              if (cancelled) return
              const code = event?.data
              const message = ERROR_MESSAGES[code] ?? `YouTube player error (code ${code}).`
              stopTicker()
              setStatus('error')
              setError(message)
              callbacksRef.current.onError?.({ code, message })
            },
          },
        })

        playerRef.current = player
      })
      .catch((loadError) => {
        if (cancelled) return
        const message = loadError?.message ?? 'Could not load the YouTube player.'
        setStatus('error')
        setError(message)
        callbacksRef.current.onError?.({ code: 'api_load_failed', message })
      })

    return () => {
      cancelled = true
      isReadyRef.current = false
      stopTicker()
      const player = playerRef.current
      playerRef.current = null
      try {
        player?.destroy?.()
      } catch {
        // The iframe can already be gone after a navigation; nothing to clean.
      }
      container.replaceChildren()
    }
  }, [normalizedId, attempt])

  const visibleStatus = invalidId ? 'error' : !normalizedId ? 'empty' : status
  const visibleError = invalidId
    ? 'This is not a valid YouTube video id. Use the 11-character id from the video URL.'
    : error

  const retry = () => {
    isReadyRef.current = false
    setStatus('loading')
    setError(null)
    setCurrentTime(0)
    setDuration(0)
    setPlayerState(PLAYER_STATE.UNSTARTED)
    setAttempt((value) => value + 1)
  }

  const isPlaying =
    playerState === PLAYER_STATE.PLAYING || playerState === PLAYER_STATE.BUFFERING

  // In synced mode the parent supplies the handlers: controls ask the server
  // instead of touching the player, so every client receives the same state.
  const synced = typeof onUserPlay === 'function' || typeof onUserPause === 'function'
  const canInteract = canControl && visibleStatus === 'ready'

  const togglePlayback = () => {
    if (!canInteract) {
      if (visibleStatus === 'ready' && !isPlaying) {
        if (callbacksRef.current.onLocalPlay) {
          callbacksRef.current.onLocalPlay()
        } else {
          playerRef.current?.playVideo?.()
        }
      }
      return
    }

    if (synced) {
      if (playerState === PLAYER_STATE.PLAYING) onUserPause?.()
      else onUserPlay?.()
      return
    }

    const player = playerRef.current
    if (!player) return

    if (player.getPlayerState?.() === PLAYER_STATE.PLAYING) player.pauseVideo?.()
    else player.playVideo?.()
  }

  const handleSeek = (event) => {
    const nextTime = Number(event.target.value)
    setSeekDraft(nextTime)

    if (!synced) {
      setCurrentTime(nextTime)
      playerRef.current?.seekTo?.(nextTime, true)
    }
  }

  const commitSeek = (event) => {
    const nextTime = Number(event.currentTarget.value)
    setSeekDraft(null)
    if (synced && canInteract) onUserSeek?.(nextTime)
  }

  return (
    <div className="video-player" aria-label={title}>
      <div className="video-player-frame">
        {/* Dedicated mount node: the IFrame API owns its children, React does not. */}
        <div className="video-player-mount" ref={containerRef} />

        {visibleStatus === 'loading' && (
          <div className="player-message">
            <span className="spinner" aria-hidden="true" />
            <p className="player-title">Loading player…</p>
            <p className="hint">Connecting to the YouTube IFrame API.</p>
          </div>
        )}

        {visibleStatus === 'empty' && (
          <div className="player-message">
            <p className="player-title">No video selected yet</p>
            <p className="hint">Create a room with a YouTube link to load the player.</p>
          </div>
        )}

        {visibleStatus === 'error' && (
          <div className="player-message player-message-error" role="alert">
            <p className="player-title">Video unavailable</p>
            <p className="hint">{visibleError}</p>
            {!invalidId && (
              <button type="button" className="button button-sm" onClick={retry}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div className="player-controls">
        <button
          type="button"
          className="button button-sm player-toggle"
          onClick={togglePlayback}
          disabled={visibleStatus !== 'ready' || (!canControl && isPlaying)}
          aria-label={isPlaying ? 'Pause video' : 'Play video'}
          title={canControl ? undefined : isPlaying ? 'Watching in sync' : 'Click to start video'}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>

        <span className="player-time">{formatTime(seekDraft ?? currentTime)}</span>

        <input
          className="player-seek"
          type="range"
          min={0}
          max={Math.max(duration, 0)}
          step={0.1}
          value={Math.min(seekDraft ?? currentTime, duration || 0)}
          onChange={handleSeek}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          disabled={!canInteract || duration <= 0}
          aria-label="Seek video"
        />

        <span className="player-time">{formatTime(duration)}</span>

        <span className={`player-state player-state-${visibleStatus}`}>
          {visibleStatus === 'error'
            ? 'Error'
            : visibleStatus === 'loading'
              ? 'Loading'
              : STATE_LABEL[playerState] ?? 'Ready'}
        </span>
      </div>

      <p className="hint player-meta">
        {canControl
          ? 'You control playback — everyone in the room follows you.'
          : 'Watching in sync. Only the playback controller can change playback.'}
        {normalizedId ? ` Video id: ${normalizedId}` : ''}
      </p>
    </div>
  )
})

export default VideoPlayer
