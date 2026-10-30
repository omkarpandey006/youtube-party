import { Link } from 'react-router-dom'

function AppHeader() {
  return (
    <header className="app-header">
      <Link className="app-brand" to="/">
        <span className="app-brand-dot" aria-hidden="true" />
        YouTube Party
      </Link>
      <span className="app-phase">Phase 5 · Local player</span>
    </header>
  )
}

export default AppHeader
