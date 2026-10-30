import { useRef, useState } from 'react'
import ParticipantList from './ParticipantList'
import VideoPlayer from './VideoPlayer'
import type { VideoPlayerHandle } from './VideoPlayer'
import { usePlaybackSync } from '../hooks/usePlaybackSync'
import { useRoom } from '../hooks/useRoom'
import type { RoomStatus } from '../hooks/useRoom'
import type { RoomIdentity } from '../services/session'
import type { Room } from '../types/room'
import { parseYouTubeVideoId } from '../utils/youtube'

const MAX_PARTICIPANTS = 20

const STATUS_LABEL: Record<RoomStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Offline',
}

const STATUS_HINT: Record<RoomStatus, string> = {
  connecting: 'Joining the room…',
  connected: 'You are connected. Participant changes appear instantly.',
  reconnecting: 'Connection lost. Trying to reconnect…',
  error: 'Not connected to the room.',
}

interface RoomSessionViewProps {
  roomId: string
  identity: RoomIdentity
  initialRoom: Room
  onLeave: () => void
  onRejoin: () => void
}

function RoomSessionView({
  roomId,
  identity,
  initialRoom,
  onLeave,
  onRejoin,
}: RoomSessionViewProps) {
  const {
    room,
    self,
    status,
    error,
    errorCode,
    retry,
    leave,
    assignRole,
    transferHost,
    removeParticipant,
  } = useRoom({
    roomId,
    userId: identity.userId,
    name: identity.name,
    token: identity.token,
  })

  const [copied, setCopied] = useState(false)
  const [videoInput, setVideoInput] = useState('')
  const [videoError, setVideoError] = useState<string | null>(null)

  const displayRoom = room ?? initialRoom
  const participants = displayRoom.participants
  const selfRole =
    self?.role ?? (identity.userId === displayRoom.hostId ? 'host' : 'participant')
  const canControl = selfRole === 'host' || selfRole === 'moderator'

  const playerRef = useRef<VideoPlayerHandle>(null)
  const sync = usePlaybackSync({
    roomId,
    initialVideoId: displayRoom.videoId,
    canControl,
    playerRef,
  })

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      window.prompt('Copy this room link:', window.location.href)
    }
  }

  const handleLeave = () => {
    leave()
    onLeave()
  }

  const submitVideo = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const videoId = parseYouTubeVideoId(videoInput)
    if (!videoId) {
      setVideoError('Paste a YouTube link or an 11-character video id.')
      return
    }
    setVideoError(null)
    setVideoInput('')
    sync.requestChangeVideo(videoId)
  }

  const showError = Boolean(error) && (status === 'error' || status === 'reconnecting')

  return (
    <section className="room-page">
      <div className="room-topbar">
        <div className="room-topbar-main">
          <span className="room-code-label">Room code</span>
          <div className="room-code-row">
            <strong className="room-code">{displayRoom.roomId}</strong>
            <button type="button" className="button button-ghost button-sm" onClick={copyLink}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
          </div>
        </div>

        <div className="room-topbar-actions">
          <span className={`role-badge role-${selfRole}`}>
            {selfRole === 'host'
              ? 'Host'
              : selfRole === 'moderator'
                ? 'Moderator'
                : 'Participant'}
          </span>
          <button type="button" className="button button-ghost" onClick={handleLeave}>
            Leave room
          </button>
        </div>
      </div>

      {showError && (
        <div className={`notice ${status === 'error' ? 'notice-error' : 'notice-warn'}`}>
          <p>{error}</p>
          <div className="notice-actions">
            {errorCode === 'room_not_found' || errorCode === 'kicked' ? (
              <button type="button" className="button button-sm" onClick={onLeave}>
                Back to home
              </button>
            ) : errorCode === 'not_a_participant' ? (
              <button type="button" className="button button-sm" onClick={onRejoin}>
                Join again
              </button>
            ) : (
              status === 'error' && (
                <button type="button" className="button button-sm" onClick={retry}>
                  Retry connection
                </button>
              )
            )}
          </div>
        </div>
      )}

      {sync.error && (
        <div className="notice notice-error" role="alert">
          <p>{sync.error}</p>
        </div>
      )}

      {sync.needsGesture && (
        <div className="notice notice-warn sync-gesture">
          <p>Your browser paused the video. Tap once to join the playback.</p>
          <div className="notice-actions">
            <button type="button" className="button button-sm" onClick={sync.enablePlayback}>
              Tap to play
            </button>
          </div>
        </div>
      )}

      <div className="room-layout">
        <div className="card player-card">
          <div className="card-heading">
            <h2>Video</h2>
            <span className="hint">
              {sync.canControl
                ? 'You control playback for everyone'
                : 'Host and moderators control playback'}
            </span>
          </div>

          <VideoPlayer
            ref={playerRef}
            key={sync.videoId ?? 'no-video'}
            videoId={sync.videoId}
            title={`Room ${displayRoom.roomId} video`}
            canControl={sync.canControl}
            onReady={sync.onPlayerReady}
            onStateChange={sync.onPlayerStateChange}
            onEnded={sync.onPlayerEnded}
            onLocalPlay={sync.enablePlayback}
            onTimeUpdate={sync.onTimeUpdate}
            onUserPlay={sync.requestPlay}
            onUserPause={sync.requestPause}
            onUserSeek={sync.requestSeek}
          />

          {sync.canControl && (
            <form className="sync-video-form" onSubmit={submitVideo}>
              <input
                id="change-video"
                value={videoInput}
                onChange={(event) => setVideoInput(event.target.value)}
                placeholder="Paste a YouTube link to change the video"
                aria-label="Change video"
              />
              <button type="submit" className="button button-sm">
                Change video
              </button>
            </form>
          )}
          {videoError && <p className="hint form-error">{videoError}</p>}

          {import.meta.env.DEV && (
            <p className="hint sync-hud">
              sync · seq {sync.seq} · drift {sync.driftMs === null ? '—' : `${sync.driftMs} ms`}
            </p>
          )}
        </div>

        <aside className="card participants-card">
          <div className="card-heading">
            <h2>
              Participants <span className="muted">({participants.length}/{MAX_PARTICIPANTS})</span>
            </h2>
          </div>

          <ParticipantList
            participants={participants}
            selfUserId={identity.userId}
            selfRole={selfRole}
            onAssignRole={(targetUserId, role) => void assignRole(targetUserId, role)}
            onTransferHost={(targetUserId) => void transferHost(targetUserId)}
            onRemoveParticipant={(targetUserId) => void removeParticipant(targetUserId)}
          />

          <p className="status-line">
            <span className={`dot${status === 'connected' ? ' dot-online' : ''}`} aria-hidden="true" />
            {STATUS_HINT[status]}
          </p>

          <p className="hint">
            Joined as <strong>{identity.name}</strong>. This identity belongs to this browser tab
            (not an account) and is backed by a signed room token.
          </p>
        </aside>
      </div>
    </section>
  )
}

export default RoomSessionView
