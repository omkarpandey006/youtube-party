import type { ForwardRefExoticComponent, RefAttributes } from 'react'

export interface VideoPlayerTimeUpdate {
  currentTime: number
  duration: number
}

export interface VideoPlayerStateChange {
  state: number
}

export interface VideoPlayerError {
  code: number | string
  message: string
}

export interface VideoPlayerHandle {
  play: () => void
  pause: () => void
  seekTo: (seconds: number) => void
  getCurrentTime: () => number
  getDuration: () => number
  getPlayerState: () => number
  setPlaybackRate: (rate: number) => void
  getPlaybackRate: () => number
  isReady: () => boolean
}

export interface VideoPlayerProps {
  videoId: string | null | undefined
  title?: string
  /** false disables the custom controls (viewer without playback rights). */
  canControl?: boolean
  onReady?: (payload: { player: unknown }) => void
  onStateChange?: (payload: VideoPlayerStateChange) => void
  onTimeUpdate?: (payload: VideoPlayerTimeUpdate) => void
  onError?: (payload: VideoPlayerError) => void
  onEnded?: () => void
  onLocalPlay?: () => void
  /** Synced mode: controls ask the server instead of touching the player. */
  onUserPlay?: () => void
  onUserPause?: () => void
  onUserSeek?: (seconds: number) => void
}

declare const VideoPlayer: ForwardRefExoticComponent<
  VideoPlayerProps & RefAttributes<VideoPlayerHandle>
>

export default VideoPlayer
