const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

/**
 * True only for a plain 11-character YouTube video id (letters, digits, `-`, `_`).
 * Used as the single guard before an id is handed to the IFrame player, so no
 * arbitrary user string ever reaches the embed URL.
 */
export function isValidYouTubeVideoId(value: unknown): value is string {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value.trim())
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  return VIDEO_ID_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * Accepts a raw 11-character id or the common YouTube URL shapes:
 * watch?v=, youtu.be/, shorts/, live/, embed/, v/.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  const direct = clean(value)
  if (direct) return direct

  let url: URL
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '')

  if (host === 'youtu.be') {
    return clean(url.pathname.split('/').filter(Boolean)[0])
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const fromQuery = clean(url.searchParams.get('v'))
    if (fromQuery) return fromQuery

    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(parts[0])) {
      return clean(parts[1])
    }
  }

  return null
}

export function youtubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}
