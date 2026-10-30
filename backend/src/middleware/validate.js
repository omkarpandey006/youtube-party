import { AppError } from '../utils/AppError.js'

/**
 * Validates req.body or req.params against a zod schema.
 * On success the parsed (trimmed / normalised) value replaces the raw input.
 */
export function validate(schema, source = 'body') {
  return function validateRequest(req, res, next) {
    const result = schema.safeParse(req[source] ?? {})

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }))
      return next(AppError.badRequest('Request validation failed', details))
    }

    if (source === 'params') {
      Object.assign(req.params, result.data)
    } else {
      req[source] = result.data
    }

    return next()
  }
}

export default validate
