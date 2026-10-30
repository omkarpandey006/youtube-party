import { randomInt } from 'node:crypto'

/**
 * 32 characters: no 0/O, 1/I/L to keep codes readable when typed by hand.
 * 32^6 ≈ 1.07 billion combinations, generated with a CSPRNG (crypto.randomInt).
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/

/** Generates a cryptographically random room code (unbiased, uniform). */
export function generateRoomCode(length = ROOM_CODE_LENGTH) {
  let code = ''
  for (let index = 0; index < length; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export function normalizeRoomCode(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
}

export function isValidRoomCode(value) {
  return ROOM_CODE_PATTERN.test(normalizeRoomCode(value))
}
