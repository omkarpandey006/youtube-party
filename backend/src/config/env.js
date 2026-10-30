import 'dotenv/config'

function readNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Comma-separated env value -> trimmed array (falls back when empty). */
function readList(value, fallback) {
  const items = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : fallback
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: readNumber(process.env.PORT, 5000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  allowedOrigins: readList(process.env.CLIENT_ORIGIN, ['http://localhost:5173']),

  socket: {
    // How long a participant token stays valid (default 12 hours).
    participantTokenTtlMs: readNumber(
      process.env.PARTICIPANT_TOKEN_TTL_MS,
      12 * 60 * 60 * 1000,
    ),
    maxHttpBufferSize: readNumber(process.env.SOCKET_MAX_BUFFER_BYTES, 100_000),
  },

  // Database
  mongodbUri: process.env.MONGODB_URI ?? '',
  mongodbDb: process.env.MONGODB_DB ?? 'youtube_party',
  mongodbServerSelectionTimeoutMs: readNumber(
    process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    10_000,
  ),
  mongodbConnectTimeoutMs: readNumber(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10_000),
}

export const isProduction = env.nodeEnv === 'production'
export const hasDatabaseUri = Boolean(env.mongodbUri.trim())
export const hasSessionSecret = Boolean(process.env.SESSION_SECRET?.trim())

/**
 * Fails the boot when a development shortcut would be unsafe in production.
 */
export function assertRuntimeConfig() {
  if (!isProduction) return

  if (!hasSessionSecret) {
    throw new Error(
      'SESSION_SECRET must be set in production (32+ random characters). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  if (env.allowedOrigins.includes('*')) {
    throw new Error('CLIENT_ORIGIN must list explicit origins in production, "*" is not allowed')
  }
}
