import { useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { subscriberApi } from '../lib/api'

export default function Unsubscribe() {
  const [searchParams] = useSearchParams()
  const tokenFromUrl = searchParams.get('token') || ''

  const [token, setToken] = useState(tokenFromUrl)
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  async function handleUnsubscribe(e: React.FormEvent) {
    e.preventDefault()
    setStatus('loading')
    setError('')

    try {
      await subscriberApi.unsubscribe(token || email)
      setStatus('done')
    } catch (err: any) {
      setError(err.message || 'Failed to unsubscribe.')
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-6">
      <motion.div
        className="ive-card max-w-[480px] w-full text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {status === 'done' ? (
          <div className="space-y-4">
            <span className="text-[40px] block">👋</span>
            <h1 className="text-title text-ink">You've been unsubscribed.</h1>
            <p className="text-body text-ink-secondary">
              We're sorry to see you go. You can always re-subscribe from our homepage.
            </p>
            <Link to="/" className="ive-button-secondary inline-flex mt-4">
              Back to home
            </Link>
          </div>
        ) : (
          <form onSubmit={handleUnsubscribe} className="space-y-6">
            <div>
              <h1 className="text-title text-ink mb-2">Unsubscribe</h1>
              <p className="text-body text-ink-secondary">
                Enter your email or use the link from your newsletter.
              </p>
            </div>

            {!tokenFromUrl && (
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="ive-input"
                required={!token}
              />
            )}

            {error && (
              <p className="text-caption text-signal-breakout">{error}</p>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="ive-button w-full"
            >
              {status === 'loading' ? 'Unsubscribing…' : 'Unsubscribe'}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  )
}
