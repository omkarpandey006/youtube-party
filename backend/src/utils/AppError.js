/**
 * Error type for expected, client-facing failures.
 * Anything that is not an AppError is treated as an internal error and is
 * never exposed to the client.
 */
export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    if (details) this.details = details
  }

  static badRequest(message, details) {
    return new AppError(400, 'validation_error', message, details)
  }

  static notFound(message = 'Resource not found') {
    return new AppError(404, 'not_found', message)
  }

  static conflict(code, message) {
    return new AppError(409, code, message)
  }

  static serviceUnavailable(code, message) {
    return new AppError(503, code, message)
  }
}

export default AppError
