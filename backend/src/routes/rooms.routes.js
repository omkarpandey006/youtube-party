import { Router } from 'express'
import { createRoom, getRoom, joinRoom } from '../controllers/room.controller.js'
import { validate } from '../middleware/validate.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import {
  createRoomBodySchema,
  joinRoomBodySchema,
  roomIdParamsSchema,
} from '../utils/validation.js'

const router = Router()

router.post('/', validate(createRoomBodySchema), asyncHandler(createRoom))

router.get(
  '/:roomId',
  validate(roomIdParamsSchema, 'params'),
  asyncHandler(getRoom),
)

router.post(
  '/:roomId/join',
  validate(roomIdParamsSchema, 'params'),
  validate(joinRoomBodySchema),
  asyncHandler(joinRoom),
)

export default router
