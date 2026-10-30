import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, joinRoom as joinRoomApi } from '../services/api'
import { saveRoomIdentity } from '../services/session'
import { acquireWatchPartySocket, releaseWatchPartySocket } from '../socket/socket'
import type { SocketResult, WatchPartySocket } from '../socket/socket'
import type { Participant, Room, RoomSelf, RoomSession } from '../types/room'

export type RoomStatus = 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface UseRoomResult {
  room: Room | null
  self: RoomSelf | null
  status: RoomStatus
  error: string | null
  errorCode: string | null
  retry: () => void
  leave: () => void
}

interface UseRoomArgs {
  roomId: string
  userId: string
  name: string
  token: string
}

const JOIN_TIMEOUT_MS = 8000

function failed(code: string, message: string): SocketResult<RoomSession> {
  return { ok: false, code, message }
}

/**
 * Connects the Socket.IO client, joins the room with the signed participant
 * token and keeps the participant list in sync.
 *
 * - Rejoins automatically after every reconnect (the server is stateless).
 * - If the token expired (server restart / 12 h TTL) or the participant was
 *   removed, it refreshes identity once through the REST join endpoint.
 */
export function useRoom({ roomId, userId, name, token }: UseRoomArgs): UseRoomResult {
  const socketRef = useRef<WatchPartySocket | null>(null)
  const tokenRef = useRef(token)
  const nameRef = useRef(name)
  const joinedRef = useRef(false)
  const disposedRef = useRef(false)

  const [room, setRoom] = useState<Room | null>(null)
  const [self, setSelf] = useState<RoomSelf | null>(null)
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  useEffect(() => {
    nameRef.current = name
  }, [name])

  useEffect(() => {
    disposedRef.current = false

    // A single socket is shared per tab; acquire reuses an in-flight connection
    // instead of opening a second one.
    const socket = acquireWatchPartySocket()
    socketRef.current = socket

    const updateParticipants = (participants: Participant[]) => {
      setRoom((current) => (current ? { ...current, participants } : current))
    }

    const emitJoin = () =>
      new Promise<SocketResult<RoomSession>>((resolve) => {
        let settled = false
        const timer = window.setTimeout(() => {
          if (settled) return
          settled = true
          resolve(failed('timeout', 'The server did not respond in time.'))
        }, JOIN_TIMEOUT_MS)

        socket.emit('join_room', { roomId, token: tokenRef.current }, (result) => {
          if (settled) return
          settled = true
          window.clearTimeout(timer)
          resolve(result)
        })
      })

    const tryJoin = async (isRetry: boolean): Promise<void> => {
      const result = await emitJoin()
      if (disposedRef.current) return

      if (result.ok) {
        joinedRef.current = true
        setRoom(result.data.room)
        setSelf(result.data.self)
        setStatus('connected')
        setError(null)
        setErrorCode(null)
        return
      }

      const canRefresh =
        !isRetry && (result.code === 'invalid_token' || result.code === 'not_a_participant')

      // Reusing a socket that the server still has in this room: reconnect to
      // get a clean handshake and a fresh room_state.
      if (!isRetry && result.code === 'already_in_room') {
        socket.disconnect()
        socket.connect()
        return
      }

      if (canRefresh) {
        try {
          const refreshed = await joinRoomApi(roomId, {
            name: nameRef.current,
            userId,
          })
          if (disposedRef.current) return

          tokenRef.current = refreshed.token
          saveRoomIdentity({
            roomId,
            userId: refreshed.userId,
            name: nameRef.current,
            token: refreshed.token,
          })
          setRoom(refreshed.room)
          await tryJoin(true)
          return
        } catch (refreshError) {
          if (disposedRef.current) return
          const message =
            refreshError instanceof ApiError
              ? refreshError.message
              : 'Could not rejoin the room.'
          setStatus('error')
          setError(message)
          setErrorCode(refreshError instanceof ApiError ? refreshError.code : 'rejoin_failed')
          return
        }
      }

      joinedRef.current = false
      setStatus('error')
      setError(result.message)
      setErrorCode(result.code)
    }

    const handleConnect = () => {
      if (disposedRef.current) return
      setStatus(joinedRef.current ? 'reconnecting' : 'connecting')
      void tryJoin(false)
    }

    const handleRoomState = (payload: RoomSession) => {
      if (disposedRef.current) return
      setRoom(payload.room)
      setSelf(payload.self)
    }

    const handleParticipants = (payload: { participants: Participant[] }) => {
      if (!disposedRef.current) updateParticipants(payload.participants)
    }

    const handleDisconnect = (reason: string) => {
      if (disposedRef.current) return
      if (reason === 'io client disconnect') return
      setStatus('reconnecting')
    }

    const handleConnectError = (connectError: Error) => {
      if (disposedRef.current) return
      setStatus('reconnecting')
      setError(
        connectError.message
          ? `Connection problem: ${connectError.message}`
          : 'Connection problem, retrying…',
      )
    }

    const handleReconnectAttempt = () => {
      if (!disposedRef.current) setStatus('reconnecting')
    }

    socket.on('connect', handleConnect)
    socket.on('room_state', handleRoomState)
    socket.on('participant_joined', handleParticipants)
    socket.on('participant_updated', handleParticipants)
    socket.on('participant_left', handleParticipants)
    socket.on('disconnect', handleDisconnect)
    socket.on('connect_error', handleConnectError)
    socket.io.on('reconnect_attempt', handleReconnectAttempt)

    // If the shared socket is already connected (remount while online), the
    // `connect` event will not fire again, so join explicitly.
    if (socket.connected) {
      void tryJoin(false)
    } else {
      socket.connect()
    }

    return () => {
      disposedRef.current = true
      joinedRef.current = false

      // Unregister only our own handlers. `socket.io.removeAllListeners()` must
      // never be used: it also detaches the Socket's internal manager
      // subscriptions, leaving `connected: false` with no events forever.
      socket.off('connect', handleConnect)
      socket.off('room_state', handleRoomState)
      socket.off('participant_joined', handleParticipants)
      socket.off('participant_updated', handleParticipants)
      socket.off('participant_left', handleParticipants)
      socket.off('disconnect', handleDisconnect)
      socket.off('connect_error', handleConnectError)
      socket.io.off('reconnect_attempt', handleReconnectAttempt)

      socketRef.current = null
      releaseWatchPartySocket()
    }
  }, [roomId, userId])

  const retry = useCallback(() => {
    const socket = socketRef.current
    if (!socket) return

    setError(null)
    setErrorCode(null)
    setStatus('connecting')
    socket.disconnect()
    socket.connect()
  }, [])

  const leave = useCallback(() => {
    const socket = socketRef.current
    socketRef.current = null
    if (!socket) return

    socket.emit('leave_room', {}, () => {
      socket.disconnect()
    })
    // Disconnect even if the ack never arrives.
    window.setTimeout(() => socket.disconnect(), 400)
  }, [])

  return { room, self, status, error, errorCode, retry, leave }
}
