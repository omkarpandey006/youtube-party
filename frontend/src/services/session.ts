const IDENTITY_PREFIX = 'ytp:identity:'
const USER_ID_KEY = 'ytp:user-id'
const NAME_KEY = 'ytp:name'

export interface RoomIdentity {
  roomId: string
  userId: string
  name: string
  token: string
  savedAt: number
}

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function write(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // Storage can be full or blocked (private mode); the app still works,
    // the user just has to join again after a refresh.
  }
}

function remove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // ignore
  }
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  // Fallback for browsers without randomUUID outside a secure context.
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * One identity per browser tab (sessionStorage). Two tabs therefore count as
 * two participants, which is exactly what local testing needs.
 */
export function getOrCreateUserId(): string {
  const existing = read(sessionStorage, USER_ID_KEY)
  if (existing) return existing

  const created = createId()
  write(sessionStorage, USER_ID_KEY, created)
  return created
}

export function readRoomIdentity(roomId: string): RoomIdentity | null {
  const raw = read(sessionStorage, `${IDENTITY_PREFIX}${roomId.toUpperCase()}`)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<RoomIdentity>
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.token !== 'string'
    ) {
      return null
    }

    return {
      roomId: roomId.toUpperCase(),
      userId: parsed.userId,
      name: parsed.name,
      token: parsed.token,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveRoomIdentity(identity: Omit<RoomIdentity, 'savedAt'>): void {
  const roomId = identity.roomId.toUpperCase()
  write(
    sessionStorage,
    `${IDENTITY_PREFIX}${roomId}`,
    JSON.stringify({ ...identity, roomId, savedAt: Date.now() }),
  )
}

export function clearRoomIdentity(roomId: string): void {
  remove(sessionStorage, `${IDENTITY_PREFIX}${roomId.toUpperCase()}`)
}

/** Remembers the display name across tabs/rooms on this device (not an account). */
export function readPreferredName(): string {
  return read(localStorage, NAME_KEY) ?? ''
}

export function savePreferredName(name: string): void {
  write(localStorage, NAME_KEY, name)
}
