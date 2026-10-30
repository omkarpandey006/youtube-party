import {
  createRoom as createRoomService,
  getRoom as getRoomService,
  joinRoom as joinRoomService,
} from '../services/room.service.js'

/** POST /api/rooms */
export async function createRoom(req, res) {
  const { hostName, hostId, videoId } = req.body
  const result = await createRoomService({ hostName, hostId, videoId })

  res.status(201).json({
    ok: true,
    data: {
      room: result.room,
      hostId: result.hostId,
      token: result.token,
    },
  })
}

/** GET /api/rooms/:roomId */
export async function getRoom(req, res) {
  const result = await getRoomService(req.params.roomId)

  res.status(200).json({
    ok: true,
    data: {
      room: result.room,
    },
  })
}

/** POST /api/rooms/:roomId/join */
export async function joinRoom(req, res) {
  const result = await joinRoomService({
    roomId: req.params.roomId,
    name: req.body.name,
    userId: req.body.userId,
  })

  res.status(200).json({
    ok: true,
    data: {
      room: result.room,
      userId: result.userId,
      joined: result.joined,
      token: result.token,
    },
  })
}
