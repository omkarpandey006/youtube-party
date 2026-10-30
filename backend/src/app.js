import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './config/env.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFoundHandler } from './middleware/notFound.js'
import apiRoutes from './routes/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDistPath = path.resolve(__dirname, '../../frontend/dist')

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true)
        if (env.allowedOrigins.includes(origin)) return callback(null, true)
        if (env.nodeEnv !== 'production' && origin.includes('localhost')) {
          return callback(null, true)
        }
        return callback(null, true)
      },
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '100kb' }))

  app.use('/api', apiRoutes)

  // Serve production frontend assets when built
  if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next()
      }
      res.sendFile(path.join(frontendDistPath, 'index.html'))
    })
  }

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
