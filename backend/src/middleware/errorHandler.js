import { AppError } from '../utils/AppError.js'
import { logger } from '../utils/logger.js'

/**
 * Maps any thrown value to a safe, consistent JSON payload.
 * Internal details are logged, never returned to the client.
 */
function normalizeError(err) {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    }
  }

  // Body-parser: malformed JSON.
  if (err?.type === 'entity.parse.failed') {
    return {
      status: 400,
      code: 'invalid_json',
      message: 'Request body is not valid JSON',
    }
  }

  // Body-parser: payload too large.
  if (err?.type === 'entity.too.large') {
    return {
      status: 413,
      code: 'payload_too_large',
      message: 'Request body is too large',
    }
  }

  // Mongoose document validation.
  if (err?.name === 'ValidationError') {
    return {
      status: 400,
      code: 'validation_error',
      message: 'Request validation failed',
      details: Object.entries(err.errors ?? {}).map(([field, validationError]) => ({
        field,
        message: validationError.message,
      })),
    }
  }

  // Mongoose cast (e.g. wrong type reaching a query).
  if (err?.name === 'CastError') {
    return {
      status: 400,
      code: 'invalid_parameter',
      message: `Invalid value for "${err.path}"`,
    }
  }

  // Unique index violation that escaped the service layer.
  if (err?.code === 11000) {
    return {
      status: 409,
      code: 'conflict',
      message: 'Resource already exists',
    }
  }

  return {
    status: 500,
    code: 'internal_error',
    message: 'Internal server error',
  }
}

// eslint-disable-next-line no-unused-vars -- Express needs 4 args to detect error middleware.
export function errorHandler(err, req, res, next) {
  const { status, code, message, details } = normalizeError(err)

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${status} ${code}`, err)
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status} ${code}: ${message}`)
  }

  const body = { ok: false, code, message }
  if (details) body.details = details

  res.status(status).json(body)
}

export default errorHandler
