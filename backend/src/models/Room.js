import mongoose from 'mongoose'

const { Schema } = mongoose

export const ROLES = ['host', 'moderator', 'participant']
export const PLAYBACK_STATUSES = ['paused', 'playing', 'ended']

export const ROOM_CODE_LENGTH = 6
export const MAX_PARTICIPANTS = 20
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/

/**
 * One person inside a room.
 * `userId` is a client-generated opaque id (Phase 3); it is not an account.
 */
const participantSchema = new Schema(
  {
    userId: {
      type: String,
      required: [true, 'participant userId is required'],
      trim: true,
      maxlength: [64, 'participant userId is too long'],
    },
    name: {
      type: String,
      required: [true, 'participant name is required'],
      trim: true,
      minlength: [1, 'participant name cannot be empty'],
      maxlength: [40, 'participant name cannot exceed 40 characters'],
    },
    role: {
      type: String,
      enum: {
        values: ROLES,
        message: 'role must be one of: host, moderator, participant',
      },
      default: 'participant',
    },
    socketId: {
      type: String,
      default: null,
      trim: true,
    },
    connected: {
      type: Boolean,
      default: false,
    },
    joinedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  { _id: false },
)

const roomSchema = new Schema(
  {
    /** Public 6-character code used in the room URL. */
    roomId: {
      type: String,
      required: [true, 'roomId is required'],
      unique: true,
      uppercase: true,
      trim: true,
      match: [ROOM_CODE_PATTERN, 'roomId must be 6 uppercase letters or digits'],
    },

    /** YouTube video id (the part after watch?v=). null until a video is picked. */
    videoId: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: (value) => value === null || YOUTUBE_ID_PATTERN.test(value),
        message: 'videoId must be a valid 11-character YouTube video id',
      },
    },

    /** Playback state that the sync engine broadcasts. */
    playbackStatus: {
      type: String,
      enum: {
        values: PLAYBACK_STATUSES,
        message: 'playbackStatus must be one of: paused, playing, ended',
      },
      default: 'paused',
    },

    /** Playback position in seconds at `playbackUpdatedAt`. */
    currentTime: {
      type: Number,
      default: 0,
      min: [0, 'currentTime cannot be negative'],
      validate: {
        validator: (value) => Number.isFinite(value),
        message: 'currentTime must be a finite number',
      },
    },

    /** Server timestamp for `currentTime`; clients extrapolate from this. */
    playbackUpdatedAt: {
      type: Date,
      default: () => new Date(),
    },

    /** userId of the participant who controls playback. */
    hostId: {
      type: String,
      required: [true, 'hostId is required'],
      trim: true,
      maxlength: [64, 'hostId is too long'],
    },

    /**
     * userId allowed to change playback. Starts as the host and can be handed
     * to another participant by the host (`playback_grant_control`).
     */
    controllerId: {
      type: String,
      default: null,
      trim: true,
      maxlength: [64, 'controllerId is too long'],
    },

    /** Incremented by every playback command; clients drop stale states. */
    seq: {
      type: Number,
      default: 0,
      min: [0, 'seq cannot be negative'],
    },

    participants: {
      type: [participantSchema],
      default: [],
      validate: [
        {
          validator: (participants) => participants.length <= MAX_PARTICIPANTS,
          message: `a room cannot have more than ${MAX_PARTICIPANTS} participants`,
        },
        {
          validator: (participants) => {
            const ids = participants.map((p) => p.userId)
            return new Set(ids).size === ids.length
          },
          message: 'participant userIds must be unique inside a room',
        },
        {
          validator: (participants) => {
            const hosts = participants.filter((p) => p.role === 'host')
            return hosts.length <= 1
          },
          message: 'a room can have at most one host',
        },
      ],
    },

    /** Used later for idle-room cleanup. */
    lastActivityAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret._id
        // socketId is server-internal; never send it to clients.
        if (Array.isArray(ret.participants)) {
          ret.participants = ret.participants.map(({ socketId, ...participant }) => participant)
        }
        // Extrapolate real-time position for playing rooms so REST responses are up-to-date
        if (ret.playbackStatus === 'playing' && ret.playbackUpdatedAt) {
          const now = Date.now()
          const updatedAt = new Date(ret.playbackUpdatedAt).getTime()
          const elapsed = Math.max(0, (now - updatedAt) / 1000)
          ret.currentTime = Math.round(((Number(ret.currentTime) || 0) + elapsed) * 1000) / 1000
        }
        return ret
      },
    },
  },
)

// Supports the idle-room cleanup query planned for a later phase.
roomSchema.index({ lastActivityAt: 1 })

// The host of a room must be one of its participants (once participants exist).
roomSchema.pre('validate', function ensureHostIsAParticipant() {
  if (this.participants.length === 0) return

  const host = this.participants.find((participant) => participant.role === 'host')
  if (!host) {
    this.invalidate('participants', 'participants must include exactly one host')
    return
  }
  if (host.userId !== this.hostId) {
    this.invalidate('hostId', 'hostId must match the participant whose role is host')
  }
})

roomSchema.methods.isHost = function isHost(userId) {
  return Boolean(userId) && this.hostId === userId
}

roomSchema.methods.isModerator = function isModerator(userId) {
  if (!userId) return false
  const participant = this.getParticipant(userId)
  return participant?.role === 'moderator'
}

roomSchema.methods.canModerate = function canModerate(userId) {
  return this.isHost(userId) || this.isModerator(userId)
}

roomSchema.methods.isPlaybackController = function isPlaybackController(userId) {
  return (this.controllerId || this.hostId) === userId
}

roomSchema.methods.canControlPlayback = function canControlPlayback(userId) {
  if (!userId) return false
  return this.isHost(userId) || this.isModerator(userId)
}

roomSchema.methods.canRemoveParticipant = function canRemoveParticipant(userId) {
  return this.isHost(userId)
}

roomSchema.methods.getParticipant = function getParticipant(userId) {
  return this.participants.find((participant) => participant.userId === userId) ?? null
}

roomSchema.methods.markActivity = function markActivity() {
  this.lastActivityAt = new Date()
  return this
}

roomSchema.statics.findByRoomId = function findByRoomId(roomId) {
  return this.findOne({ roomId: String(roomId).trim().toUpperCase() })
}

const Room = mongoose.model('Room', roomSchema)

export default Room
