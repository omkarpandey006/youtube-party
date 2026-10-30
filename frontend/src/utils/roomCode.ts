const ROOM_CODE_PATTERN = /^[A-Za-z0-9]{6}$/

/**
 * Accepts `ABC123`, `abc123` or a full room URL such as
 * `http://localhost:5173/room/ABC123`.
 */
export function parseRoomCode(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  const fromUrl = value.match(/\/room\/([A-Za-z0-9]{6})(?:[/?#]|$)/i)
  if (fromUrl) return fromUrl[1].toUpperCase()

  return ROOM_CODE_PATTERN.test(value) ? value.toUpperCase() : null
}
