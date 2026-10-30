/**
 * Masks the credentials inside a MongoDB connection string so it is safe to log.
 * Never log the raw URI — Atlas URLs contain the database password.
 */
export function redactMongoUri(uri) {
  if (!uri) return '(not set)'

  try {
    const parsed = new URL(uri)
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    // Fallback for strings the URL parser rejects.
    return uri.replace(/\/\/([^@/]+)@/, '//***:***@')
  }
}
