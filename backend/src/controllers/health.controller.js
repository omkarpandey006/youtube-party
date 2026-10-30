import { getDatabaseStatus } from '../config/db.js'

export function healthController(req, res) {
  const database = getDatabaseStatus()
  const isReady = database.state === 'connected'

  res.status(200).json({
    status: isReady ? 'ok' : 'degraded',
    service: 'youtube-party-backend',
    uptime: Number(process.uptime().toFixed(3)),
    timestamp: new Date().toISOString(),
    database: {
      state: database.state,
      name: database.name,
    },
  })
}
