import { Router } from 'express'
import healthRoutes from './health.routes.js'
import roomRoutes from './rooms.routes.js'

const router = Router()

router.use(healthRoutes)
router.use('/rooms', roomRoutes)

export default router
