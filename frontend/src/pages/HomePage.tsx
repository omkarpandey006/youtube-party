import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle'
import { ApiError, createRoom, joinRoom } from '../services/api'
import {
  getOrCreateUserId,
  readPreferredName,
  savePreferredName,
  saveRoomIdentity,
} from '../services/session'
import { parseRoomCode } from '../utils/roomCode'
import { parseYouTubeVideoId } from '../utils/youtube'

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

function HomePage() {
  const navigate = useNavigate()
  usePageTitle('Home')

  const [name, setName] = useState(() => readPreferredName())

  const [videoInput, setVideoInput] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)

  const rememberName = (value: string) => {
    savePreferredName(value)
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreateError(null)

    const hostName = name.trim()
    if (!hostName) {
      setCreateError('Enter your name first.')
      return
    }

    let videoId: string | null = null
    if (videoInput.trim()) {
      videoId = parseYouTubeVideoId(videoInput)
      if (!videoId) {
        setCreateError('That does not look like a YouTube link or an 11-character video id.')
        return
      }
    }

    setCreating(true)
    try {
      const result = await createRoom({
        hostName,
        hostId: getOrCreateUserId(),
        videoId,
      })

      rememberName(hostName)
      saveRoomIdentity({
        roomId: result.room.roomId,
        userId: result.hostId,
        name: hostName,
        token: result.token,
      })
      navigate(`/room/${result.room.roomId}`)
    } catch (error) {
      setCreateError(errorMessage(error, 'Could not create the room. Please try again.'))
    } finally {
      setCreating(false)
    }
  }

  const handleJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setJoinError(null)

    const displayName = name.trim()
    if (!displayName) {
      setJoinError('Enter your name first.')
      return
    }

    const roomId = parseRoomCode(joinCode)
    if (!roomId) {
      setJoinError('Enter a 6-character room code or paste the room link.')
      return
    }

    setJoining(true)
    try {
      const result = await joinRoom(roomId, {
        name: displayName,
        userId: getOrCreateUserId(),
      })

      rememberName(displayName)
      saveRoomIdentity({
        roomId,
        userId: result.userId,
        name: displayName,
        token: result.token,
      })
      navigate(`/room/${roomId}`)
    } catch (error) {
      setJoinError(errorMessage(error, 'Could not join the room. Please try again.'))
    } finally {
      setJoining(false)
    }
  }

  return (
    <section>
      <div className="hero">
        <h1>Watch YouTube together</h1>
        <p className="muted">
          Create a room or join one with a code. Everyone in the room sees the same
          participant list in real time.
        </p>
      </div>

      <div className="page-grid">
        <form className="card" onSubmit={handleCreate}>
          <div className="card-heading">
            <h2>Create a room</h2>
            <span className="hint">You become the host</span>
          </div>

          <div className="form">
            <div className="field">
              <label htmlFor="create-name">Your name</label>
              <input
                id="create-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Aarav"
                maxLength={40}
                autoComplete="nickname"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="create-video">YouTube link or video id (optional)</label>
              <input
                id="create-video"
                className="input"
                value={videoInput}
                onChange={(event) => setVideoInput(event.target.value)}
                placeholder="https://youtu.be/dQw4w9WgXcQ"
                spellCheck={false}
              />
              <span className="hint">You can also add the video later.</span>
            </div>

            {createError && <p className="error-text">{createError}</p>}

            <button type="submit" className="button" disabled={creating}>
              {creating ? 'Creating…' : 'Create room'}
            </button>
          </div>
        </form>

        <form className="card" onSubmit={handleJoin}>
          <div className="card-heading">
            <h2>Join a room</h2>
            <span className="hint">Ask the host for the code</span>
          </div>

          <div className="form">
            <div className="field">
              <label htmlFor="join-code">Room code or link</label>
              <input
                id="join-code"
                className="input input-code"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="ABC123"
                maxLength={120}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="join-name">Your name</label>
              <input
                id="join-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Meera"
                maxLength={40}
                autoComplete="nickname"
                required
              />
            </div>

            {joinError && <p className="error-text">{joinError}</p>}

            <button type="submit" className="button" disabled={joining}>
              {joining ? 'Joining…' : 'Join room'}
            </button>
          </div>
        </form>
      </div>

      <div className="card info-card">
        <h2>What works today</h2>
        <ul className="checklist">
          <li>Create a room and get a shareable 6-character code</li>
          <li>Join from another tab, browser or device and see everyone live</li>
          <li>Join/leave events and connected dots powered by Socket.IO</li>
          <li>Signed participant identity — roles always come from the server</li>
          <li>Automatic rejoin after a dropped connection</li>
        </ul>
        <p className="hint">
          Video selection, synchronized playback, roles and chat come in the next phases.
        </p>
      </div>
    </section>
  )
}

export default HomePage
