import { Route, Routes } from 'react-router-dom'
import AppHeader from './components/AppHeader'
import HomePage from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'
import RoomPage from './pages/RoomPage'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/room/:roomCode" element={<RoomPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
