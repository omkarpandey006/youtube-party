import type { Participant, ParticipantRole } from '../types/room'

const ROLE_LABEL: Record<ParticipantRole, string> = {
  host: 'Host',
  moderator: 'Moderator',
  participant: 'Member',
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
}

function ParticipantList({ participants, selfUserId }: ParticipantListProps) {
  if (participants.length === 0) {
    return <p className="empty-list">No one is here yet.</p>
  }

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
