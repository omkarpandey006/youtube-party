import { Link } from 'react-router-dom'
import usePageTitle from '../hooks/usePageTitle'

function NotFoundPage() {
  usePageTitle('Page not found')

  return (
    <section className="card">
      <h1>404</h1>
      <p className="muted">Ye page exist nahi karta.</p>
      <div className="row">
        <Link className="button" to="/">
          Go home
        </Link>
      </div>
    </section>
  )
}

export default NotFoundPage
