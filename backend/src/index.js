import { createApp } from './app.js'
import { assertRuntimeConfig, env } from './config/env.js'
import { connectDB, disconnectDB } from './config/db.js'
import { initWatchPartySocket } from './sockets/watchParty.socket.js'
import { logger } from './utils/logger.js'

let server
let io
let shuttingDown = false

async function start() {
  logger.info(`Starting API (${env.nodeEnv})`)

  // Refuse unsafe production shortcuts (missing SESSION_SECRET, wildcard CORS).
  assertRuntimeConfig()

  // Fail fast: the API is useless without its database, and a clear error here
  // is much better than every request failing later.
  await connectDB()

  const app = createApp()
  server = app.listen(env.port, () => {
    logger.info(`API listening on http://localhost:${env.port} (${env.nodeEnv})`)
    logger.info(`Health check: http://localhost:${env.port}/api/health`)
    logger.info(`Socket.IO ready (allowed origins: ${env.allowedOrigins.join(', ')})`)
  })

  // Socket.IO shares the same HTTP server and port.
  io = initWatchPartySocket(server)

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${env.port} is already in use. Set PORT in backend/.env.`)
    } else {
      logger.error('HTTP server error:', error.message)
    }
    process.exit(1)
  })
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`${signal} received, shutting down`)

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  if (io) {
    await new Promise((resolve) => io.close(resolve))
    logger.info('Socket.IO closed')
  }

  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve))
  }
  logger.info('HTTP server closed')

  try {
    await disconnectDB()
  } catch (error) {
    logger.error('Error while closing MongoDB:', error.message)
  }

  clearTimeout(forceExit)
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start().catch((error) => {
  logger.error('Server failed to start.')
  logger.error(error.message)
  process.exit(1)
})
