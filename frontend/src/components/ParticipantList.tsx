import type { Participant, ParticipantRole } from '../types/room'

const ROLE_LABEL: Record<ParticipantRole, string> = {
  host: 'Host',
  moderator: 'Moderator',
  participant: 'Participant',
}

const ROLE_ORDER: Record<ParticipantRole, number> = {
  host: 0,
  moderator: 1,
  participant: 2,
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

interface ParticipantListProps {
  participants: Participant[]
  selfUserId: string | null
  selfRole?: ParticipantRole
  onAssignRole?: (userId: string, role: 'moderator' | 'participant') => void
  onTransferHost?: (userId: string) => void
  onRemoveParticipant?: (userId: string) => void
}

function ParticipantList({
  participants,
  selfUserId,
  selfRole = 'participant',
  onAssignRole,
  onTransferHost,
  onRemoveParticipant,
}: ParticipantListProps) {
  if (participants.length === 0) {
    return <p className="empty-list">No one is here yet.</p>
  }

  const isHost = selfRole === 'host'

  const ordered = [...participants].sort((first, second) => {
    if (first.userId === selfUserId) return -1
    if (second.userId === selfUserId) return 1

    const roleDifference = ROLE_ORDER[first.role] - ROLE_ORDER[second.role]
    if (roleDifference !== 0) return roleDifference

    return first.name.localeCompare(second.name)
  })

  return (
    <ul className="participant-list">
      {ordered.map((participant) => {
        const isSelf = participant.userId === selfUserId

        return (
          <li
            key={participant.userId}
            className={`participant${isSelf ? ' participant-self' : ''}`}
          >
            <span className="avatar" aria-hidden="true">
              {initials(participant.name)}
            </span>

            <span className="participant-body">
              <span className="participant-name">
                {participant.name}
                {isSelf && <span className="you-tag">you</span>}
              </span>
              <span className={`role-badge role-${participant.role}`}>
                {ROLE_LABEL[participant.role]}
              </span>
            </span>

            {!isSelf && (
              <span className="participant-actions">
                {isHost && participant.role === 'participant' && (
                  <button
                    type="button"
                    className="participant-action-btn"
                    title="Promote to moderator"
                    onClick={() => onAssignRole?.(participant.userId, 'moderator')}
                  >
                    +Mod
                  </button>
                )}
                {isHost && participant.role === 'moderator' && (
                  <button
                    type="button"
                    className="participant-action-btn"
                    title="Demote to member"
                    onClick={() => onAssignRole?.(participant.userId, 'participant')}
                  >
                    -Mod
                  </button>
                )}
                {isHost && (
                  <button
                    type="button"
                    className="participant-action-btn"
                    title="Transfer host status"
                    onClick={() => onTransferHost?.(participant.userId)}
                  >
                    Host
                  </button>
                )}
                {isHost && (
                  <button
                    type="button"
                    className="participant-action-btn participant-action-btn-danger"
                    title="Remove participant"
                    onClick={() => onRemoveParticipant?.(participant.userId)}
                  >
                    ✕
                  </button>
                )}
              </span>
            )}

            <span
              className={`dot${participant.connected ? ' dot-online' : ''}`}
              title={participant.connected ? 'Connected' : 'Disconnected'}
              aria-label={participant.connected ? 'Connected' : 'Disconnected'}
              role="img"
            />
          </li>
        )
      })}
    </ul>
  )
}

export default ParticipantList
