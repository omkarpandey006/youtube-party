import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env, isProduction } from '../config/env.js'
import { logger } from './logger.js'
import { normalizeRoomCode } from './roomCode.js'

const TOKEN_VERSION = 1
let ephemeralSecret = null

/**
 * The HMAC secret used to sign participant tokens.
 *
 * - `SESSION_SECRET` configured  -> use it.
 * - production without a secret  -> hard failure (no insecure default).
 * - development without a secret -> random per-process secret + warning, so
 *   tokens simply stop working after a restart. Never used in production.
 */
export function getSessionSecret() {
  const configured = process.env.SESSION_SECRET?.trim()
  if (configured) return configured

  if (isProduction) {
    throw new Error('SESSION_SECRET is required in production')
  }

  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex')
    logger.warn(
      'SESSION_SECRET is not set — using an ephemeral development secret. ' +
        'Participant tokens become invalid after a server restart.',
    )
  }
  return ephemeralSecret
}

function sign(body) {
  return createHmac('sha256', getSessionSecret()).update(body).digest('base64url')
}

/**
 * Issues a token that binds a participant id to one room.
 * The role is NOT part of the token on purpose: roles are always read from the
 * database, never from the client.
 */
export function signParticipantToken({ userId, roomId }) {
  if (!userId) throw new Error('userId is required to sign a participant token')

  const payload = {
    v: TOKEN_VERSION,
    userId: String(userId),
    roomId: normalizeRoomCode(roomId),
    iat: Date.now(),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

/**
 * Returns the token payload, or null when the token is malformed, tampered
 * with, expired or signed with another secret.
 */
export function verifyParticipantToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return null
  }

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = sign(body)

  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))

    if (
      payload?.v !== TOKEN_VERSION ||
      typeof payload.userId !== 'string' ||
      typeof payload.roomId !== 'string' ||
      typeof payload.iat !== 'number'
    ) {
      return null
    }

    if (Date.now() - payload.iat > env.socket.participantTokenTtlMs) return null

    return payload
  } catch {
    return null
  }
}
