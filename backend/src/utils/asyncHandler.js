/**
 * Express 4 does not forward rejected promises to the error middleware.
 * Wrap async handlers with this so every failure lands in errorHandler.
 */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

export default asyncHandler
