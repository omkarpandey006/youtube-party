/**
 * Loads the official YouTube IFrame Player API exactly once.
 *
 * The script is injected by the app (never by user input) and the promise is
 * shared between every player on the page.
 */

const API_SRC = 'https://www.youtube.com/iframe_api'
const SCRIPT_FLAG = 'data-youtube-iframe-api'
const LOAD_TIMEOUT_MS = 15_000

type YouTubeApi = {
  Player: new (element: HTMLElement | string, options: Record<string, unknown>) => unknown
}

declare global {
  interface Window {
    YT?: YouTubeApi
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YouTubeApi> | null = null

function existingApi(): YouTubeApi | null {
  const api = window.YT
  return api && typeof api.Player === 'function' ? api : null
}

export function loadYouTubeIframeApi(): Promise<YouTubeApi> {
  const ready = existingApi()
  if (ready) return Promise.resolve(ready)
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)

      if (error) {
        apiPromise = null
        reject(error)
        return
      }

      const api = existingApi()
      if (api) resolve(api)
      else {
        apiPromise = null
        reject(new Error('YouTube IFrame API loaded without a Player constructor.'))
      }
    }

    const timeout = window.setTimeout(
      () => finish(new Error('Timed out while loading the YouTube IFrame API.')),
      LOAD_TIMEOUT_MS,
    )

    const previousCallback = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.()
      finish()
    }

    if (!document.querySelector(`script[${SCRIPT_FLAG}]`)) {
      const script = document.createElement('script')
      script.src = API_SRC
      script.async = true
      script.setAttribute(SCRIPT_FLAG, 'true')
      script.addEventListener('error', () => {
        script.remove()
        finish(new Error('Could not download the YouTube IFrame API.'))
      })
      document.head.appendChild(script)
    }
  })

  return apiPromise
}
