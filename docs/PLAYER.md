# YouTube Player (Phase 5)

Local YouTube playback inside a room. **This phase is intentionally not synced** —
every participant controls their own player. Cross-user synchronization is Phase 6.

## Files

| File | Purpose |
| --- | --- |
| `frontend/src/components/VideoPlayer.jsx` | Player component (official IFrame Player API) |
| `frontend/src/components/VideoPlayer.d.ts` | Typed props, callbacks and imperative handle for TS callers |
| `frontend/src/utils/youtubeIframe.ts` | Loads `https://www.youtube.com/iframe_api` once, shares the promise |
| `frontend/src/utils/youtube.ts` | `isValidYouTubeVideoId()`, `parseYouTubeVideoId()`, URL helpers |

No new npm dependency: the IFrame API is a single script injected by the app.

## Usage

```tsx
<VideoPlayer
  key={room.videoId ?? 'no-video'}   // remount when the id changes
  videoId={room.videoId}
  title={`Room ${room.roomId} video`}
  onReady={({ player }) => {}}
  onStateChange={({ state }) => {}}
  onTimeUpdate={({ currentTime, duration }) => {}}
  onError={({ code, message }) => {}}
/>
```

| Prop | Type | Notes |
| --- | --- | --- |
| `videoId` | `string \| null` | Must be a plain 11-char id; URLs are rejected here |
| `title` | `string` | Accessible name for the player region |
| `onReady` | `({ player }) => void` | Fired once the API has a usable player |
| `onStateChange` | `({ state }) => void` | Raw `YT.PlayerState` value (`-1, 0, 1, 2, 3, 5`) |
| `onTimeUpdate` | `({ currentTime, duration }) => void` | Every 250 ms while mounted |
| `onError` | `({ code, message }) => void` | `code` is a YouTube error code or `api_load_failed` |

Imperative handle (for the Phase 6 sync engine):

```ts
export interface VideoPlayerHandle {
  play(): void
  pause(): void
  seekTo(seconds: number): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
}
```

```tsx
const playerRef = useRef<VideoPlayerHandle>(null)
playerRef.current?.seekTo(42)
```

## Safety rules

1. **Validation before embedding** — `isValidYouTubeVideoId()` accepts only
   `^[A-Za-z0-9_-]{11}$` (trimmed). Anything else renders an error and the API is
   never called, so no user string is interpolated into an embed URL.
2. **No raw iframe HTML** — the iframe is created by `new YT.Player(...)`; the app
   never renders `<iframe>` from user input.
3. **Privacy-enhanced host** — embeds use `https://www.youtube-nocookie.com`.
4. **Dedicated mount node** — the API replaces the mount node's children, React
   renders the overlays as siblings (a shared container makes React's reconciliation
   crash with `removeChild`).
5. **Cleanup** — on unmount/video change the 250 ms ticker stops, `player.destroy()`
   runs and the iframe is removed from the DOM.

## States

| State | UI |
| --- | --- |
| loading | Spinner + "Loading player…" while the API script downloads and the player boots |
| ready | Iframe visible, custom controls enabled |
| empty | "No video selected yet" when `videoId` is null |
| error | "Video unavailable", the reason, and a **Retry** button (omitted for invalid ids) |

The status pill next to the controls shows `Loading`, `Ready`, `Playing`,
`Paused`, `Buffering…`, `Ended` or `Error`. The Play/Pause button and the seek
slider are disabled outside `ready`.

## Controls

- Custom **Play / Pause** button (`controls=0`, so YouTube's own control bar is hidden).
- Seek slider bound to `getDuration()` (0.1 s steps, calls `seekTo(t, true)`).
- Live current time and duration.
- `playsinline=1` for iOS, `rel=0`, `iv_load_policy=3`, `modestbranding=1`.
- Responsive 16:9 frame: `aspect-ratio: 16 / 9`, iframe absolutely fills it.

## Error codes

| Code | Meaning | UI message |
| --- | --- | --- |
| `2` | Invalid parameter | "YouTube rejected this video id." |
| `5` | HTML5 player error | "The HTML5 player could not start this video." |
| `100` | Removed / private / unavailable | "This video is private, removed or otherwise unavailable." |
| `101`, `150` | Owner disabled embedding | "The video owner does not allow embedding. Try another video." |
| `api_load_failed` | Script blocked, offline, or 15 s timeout | Message from the loader + Retry |

## Browser restrictions to know

- **Autoplay policy** — the player never autoplays (`autoplay=0`). Playback starts
  from a real user click, so Chrome/Safari/Firefox unmuted-autoplay blocking does
  not get in the way. This also matters for Phase 6: a sync `play` issued without a
  prior gesture may be refused, so the join/enter action must be the gesture.
- **Embedding disabled** — many music/label videos return `101/150`; that is a
  YouTube-side restriction, not a bug. The error UI says so.
- **Age-restricted / region-blocked** — may return `100` or require sign-in.
- **Network** — `youtube.com/iframe_api` and `youtube-nocookie.com` must be
  reachable; a corporate proxy or ad-blocker can block both (→ timeout / retry).
- **Harmless console noise from YouTube** — `Unrecognized feature: 'web-share'`
  and occasional `postMessage` target-origin warnings come from the embed itself.
- Cross-origin iframe internals are not inspectable; the component talks to the
  player only through the official JS API.

## Verified manually (real browser, Chrome)

Public test video: `aqz-KE-bpKQ` (Big Buck Bunny, 10:35).

| Check | Result |
| --- | --- |
| Player loads, iframe src is `youtube-nocookie.com/embed/aqz-KE-bpKQ` | ✅ |
| Status `Ready` at `0:00`, duration `10:35` | ✅ |
| Play → `Playing`, current time advances | ✅ |
| Pause → `Paused`, current time freezes | ✅ |
| Seek slider → `5:00` | ✅ |
| Invalid-but-valid-format id `AAAAAAAAAAA` → error UI + Retry, Play disabled | ✅ |
| `isValidYouTubeVideoId()` rejects URLs/HTML/short strings | ✅ |
| Navigating away removes the iframe (no leftover player) | ✅ |
| Frontend `build` + `lint` | ✅ |

## Manual test

```bash
cd backend && npm run dev        # terminal 1
cd frontend && npm run dev       # terminal 2
```

Open <http://localhost:5173>, create a room with a YouTube link (e.g.
`https://www.youtube.com/watch?v=aqz-KE-bpKQ`), then play/pause/seek.

## Next phase

Phase 6 wires `onTimeUpdate` / imperative controls into the server-authoritative
clock: `play`, `pause`, `seek`, `change_video`, `seq`, `executeAt`, heartbeat and
drift correction (<300 ms).
