export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    code: 'not_found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  })
}
