import { z } from 'zod'
import { YOUTUBE_ID_PATTERN } from '../models/Room.js'

const displayName = z
  .string({ error: 'name is required' })
  .trim()
  .min(1, 'name cannot be empty')
  .max(40, 'name cannot exceed 40 characters')

const userId = z
  .string()
  .trim()
  .min(1, 'userId cannot be empty')
  .max(64, 'userId cannot exceed 64 characters')
  .regex(/^[A-Za-z0-9_-]+$/, 'userId may only contain letters, numbers, "-" and "_"')

export const roomIdParamsSchema = z.object({
  roomId: z
    .string({ error: 'roomId is required' })
    .trim()
    .regex(/^[A-Za-z0-9]{6}$/, 'roomId must be exactly 6 letters or digits')
    .transform((value) => value.toUpperCase()),
})

export const createRoomBodySchema = z
  .object({
    hostName: displayName,
    hostId: userId.optional(),
    videoId: z
      .string()
      .trim()
      .regex(YOUTUBE_ID_PATTERN, 'videoId must be an 11-character YouTube video id')
      .nullish(),
  })
  .strict()

export const joinRoomBodySchema = z
  .object({
    name: displayName,
    userId: userId.optional(),
  })
  .strict()
