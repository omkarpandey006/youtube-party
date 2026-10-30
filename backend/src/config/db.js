import mongoose from 'mongoose'
import { env, isProduction } from './env.js'
import { logger } from '../utils/logger.js'
import { redactMongoUri } from '../utils/redact.js'

mongoose.set('strictQuery', true)

let listenersBound = false
let hasConnectedOnce = false
let closing = false

function bindConnectionEvents() {
  if (listenersBound) return
  listenersBound = true

  const connection = mongoose.connection

  connection.on('connected', () => {
    hasConnectedOnce = true
    logger.info(`MongoDB connection opened (db: ${connection.name})`)
  })
  connection.on('reconnected', () => {
    logger.warn('MongoDB reconnected')
  })
  connection.on('disconnected', () => {
    // During startup a failed attempt also emits this; only warn once we had
    // a working connection, and stay quiet during an intentional shutdown.
    if (hasConnectedOnce && !closing) logger.warn('MongoDB disconnected')
  })
  connection.on('error', (error) => {
    // Errors that happen after the initial connect (network drops, etc.).
    logger.error('MongoDB connection error:', error.message)
  })
}

/**
 * Turns driver errors into a message a human can act on, without leaking
 * the connection string.
 */
export function explainConnectionError(error, uri) {
  const target = redactMongoUri(uri)
  const raw = String(error?.message ?? error ?? 'Unknown error')
  const hints = []

  if (/Authentication failed|bad auth|code.?18/i.test(raw)) {
    hints.push('Check the database username/password in MONGODB_URI.')
    hints.push(
      'If the password has special characters (@ : / ? # [ ] %), URL-encode it (e.g. @ -> %40).',
    )
  }
  if (/ENOTFOUND|querySrv|getaddrinfo|EAI_AGAIN/i.test(raw)) {
    hints.push('The cluster host was not found. Copy the hostname again from Atlas.')
    hints.push('Check your internet connection / DNS.')
  }
  if (/ECONNREFUSED/i.test(raw)) {
    hints.push('Nothing is listening on that host:port.')
    hints.push('For a local MongoDB, start the mongod service; for Atlas use the mongodb+srv:// URI.')
  }
  if (/IP.*(not allowed|whitelist)|not allowed to access|Could not connect to any servers/i.test(raw)) {
    hints.push('Add your current IP (or 0.0.0.0/0 for development) in Atlas → Network Access.')
  }
  if (/Server selection timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(raw)) {
    hints.push('Connection timed out: usually a blocked IP, VPN, or firewall.')
  }
  if (/Invalid scheme|MongoParseError|must be a string/i.test(raw)) {
    hints.push('MONGODB_URI must start with mongodb:// or mongodb+srv://.')
  }

  const lines = [`MongoDB connection failed for: ${target}`, `Reason: ${raw}`]
  if (hints.length > 0) {
    lines.push('How to fix:')
    hints.forEach((hint) => lines.push(`  - ${hint}`))
  }
  lines.push('See docs/database.md for the Atlas setup walkthrough.')

  return lines.join('\n')
}

/**
 * Connects to MongoDB and resolves with the mongoose connection.
 * Throws an Error with a human-readable, credential-free message on failure.
 *
 * @param {object} [options]
 * @param {string} [options.uri]     Overrides env.mongodbUri (used by scripts/tests).
 * @param {string} [options.dbName]  Overrides env.mongodbDb.
 * @param {boolean} [options.quiet]  Skip the success log (used by scripts).
 */
export async function connectDB(options = {}) {
  const uri = options.uri ?? env.mongodbUri
  const dbName = options.dbName ?? env.mongodbDb

  if (!uri || !String(uri).trim()) {
    throw new Error(
      [
        'MONGODB_URI is not set.',
        'Copy backend/.env.example to backend/.env and paste your Atlas connection string.',
        'Atlas: https://cloud.mongodb.com → Database → Connect → Drivers.',
        'See docs/database.md for the full walkthrough.',
      ].join('\n'),
    )
  }

  bindConnectionEvents()

  try {
    await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: env.mongodbServerSelectionTimeoutMs,
      connectTimeoutMS: env.mongodbConnectTimeoutMs,
      socketTimeoutMS: 45_000,
      maxPoolSize: 10,
      // Indexes are created by the app in development; production builds can
      // manage them separately.
      autoIndex: !isProduction,
    })
  } catch (error) {
    throw new Error(explainConnectionError(error, uri), { cause: error })
  }

  if (!options.quiet) {
    const { host, name } = mongoose.connection
    logger.info(`MongoDB connected → ${host}/${name}`)
  }

  return mongoose.connection
}

/** Closes the connection. Safe to call when already closed. */
export async function disconnectDB() {
  if (mongoose.connection.readyState === 0) return
  closing = true
  await mongoose.disconnect()
  logger.info('MongoDB disconnected cleanly')
}

/** Human-readable connection state for logs and the health endpoint. */
export function getDatabaseStatus() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  }
  return {
    state: states[mongoose.connection.readyState] ?? 'unknown',
    name: mongoose.connection.name || null,
    host: mongoose.connection.host || null,
  }
}
