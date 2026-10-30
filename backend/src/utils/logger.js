const levels = ['log', 'info', 'warn', 'error']

function timestamp() {
  return new Date().toISOString()
}

export const logger = levels.reduce((api, level) => {
  api[level] = (...args) => {
    const output = level === 'log' ? console.log : console[level]
    output(`[${timestamp()}] [${level.toUpperCase()}]`, ...args)
  }
  return api
}, {})
