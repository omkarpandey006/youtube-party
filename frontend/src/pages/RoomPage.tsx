import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import RoomSessionView from '../components/RoomSessionView'
import usePageTitle from '../hooks/usePageTitle'
import { ApiError, getRoom, joinRoom } from '../services/api'
import {
  clearRoomIdentity,
  getOrCreateUserId,
  readPreferredName,
  readRoomIdentity,
  savePreferredName,
  saveRoomIdentity,
} from '../services/session'
import type { RoomIdentity } from '../services/session'
import type { Room } from '../types/room'

type LoadState = 'loading' | 'ready' | 'error'

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return fallback
}

function RoomPage() {
  const { roomCode = '' } = useParams()
  const code = roomCode.toUpperCase()

  // Remount when the route points at another room, so all per-room state
  // (identity, form, connection) starts clean without a sync effect.
  return <RoomPageContent key={code} code={code} />
}

function RoomPageContent({ code }: { code: string }) {
  const navigate = useNavigate()
  usePageTitle(`Room ${code || 'unknown'}`)

  const isValidCode = ROOM_CODE_PATTERN.test(code)

  const [identity, setIdentity] = useState<RoomIdentity | null>(() => readRoomIdentity(code))
  const [room, setRoom] = useState<Room | null>(null)
  const [loadState, setLoadState] = useState<LoadState>(isValidCode ? 'loading' : 'error')
  const [loadError, setLoadError] = useState<string | null>(
    isValidCode ? null : 'Room codes are exactly 6 letters or digits.',
  )

  const [name, setName] = useState(() => identity?.name ?? readPreferredName())
  const [joinError, setJoinError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    if (!isValidCode) return

    let cancelled = false

    getRoom(code)
      .then((result) => {
        if (cancelled) return
        setRoom(result.room)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(errorMessage(error, 'Could not load this room.'))
        setLoadState('error')
      })

    return () => {
      cancelled = true
    }
  }, [code, isValidCode])

  const handleJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setJoinError(null)

    const displayName = name.trim()
    if (!displayName) {
      setJoinError('Enter your name first.')
      return
    }

    setJoining(true)
    try {
      const result = await joinRoom(code, {
        name: displayName,
        userId: getOrCreateUserId(),
      })

      savePreferredName(displayName)
      const nextIdentity: RoomIdentity = {
        roomId: code,
        userId: result.userId,
        name: displayName,
        token: result.token,
        savedAt: Date.now(),
      }
      saveRoomIdentity(nextIdentity)
      setRoom(result.room)
      setIdentity(nextIdentity)
    } catch (error) {
      setJoinError(errorMessage(error, 'Could not join the room. Please try again.'))
    } finally {
      setJoining(false)
    }
  }

  const handleLeave = () => {
    clearRoomIdentity(code)
    navigate('/', { replace: true })
  }

  const handleRejoin = () => {
    clearRoomIdentity(code)
    setIdentity(null)
    setJoinError(null)
  }

  if (loadState === 'loading') {
    return (
      <section className="card">
        <p className="status status-loading">Loading room…</p>
      </section>
    )
  }

  if (loadState === 'error' || !room) {
    return (
      <section className="card">
        <h1>Room not available</h1>
        <p className="muted">{loadError ?? 'This room does not exist.'}</p>
        <div className="row">
          <Link className="button button-ghost" to="/">
            Back to home
          </Link>
        </div>
      </section>
    )
  }

  if (identity) {
    return (
      <RoomSessionView
        roomId={code}
        identity={identity}
        initialRoom={room}
        onLeave={handleLeave}
        onRejoin={handleRejoin}
      />
    )
  }

  const hostName = room.participants.find((participant) => participant.role === 'host')?.name

  return (
    <section className="card join-card">
      <p className="room-code-label">You are joining</p>
      <h1 className="room-code">{room.roomId}</h1>
      <p className="muted">
        {room.participants.length} of 20 people here
        {hostName ? ` · Host: ${hostName}` : ''}
      </p>

      <form className="form" onSubmit={handleJoin}>
        <div className="field">
          <label htmlFor="room-join-name">Your name</label>
          <input
            id="room-join-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Meera"
            maxLength={40}
            autoComplete="nickname"
            autoFocus
            required
          />
        </div>

        {joinError && <p className="error-text">{joinError}</p>}

        <button type="submit" className="button" disabled={joining}>
          {joining ? 'Joining…' : 'Join room'}
        </button>
      </form>

      <div className="row">
        <Link className="button button-ghost" to="/">
          Back to home
        </Link>
      </div>
    </section>
  )
}

export default RoomPage
