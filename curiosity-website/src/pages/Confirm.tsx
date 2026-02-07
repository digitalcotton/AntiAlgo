import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, Copy, ArrowRight } from 'lucide-react'
import { subscriberApi } from '../lib/api'

export default function Confirm() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [referralCode, setReferralCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setError('Invalid confirmation link.')
      return
    }

    subscriberApi.confirm(token)
      .then(r => {
        setReferralCode(r.referral_code)
        setStatus('success')
      })
      .catch(err => {
        setError(err.message || 'Confirmation failed.')
        setStatus('error')
      })
  }, [token])

  function copyLink() {
    const link = `${window.location.origin}/r/${referralCode}`
    navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-6">
      <motion.div
        className="ive-card max-w-[480px] w-full text-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {status === 'loading' && (
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-full bg-surface-alt mx-auto animate-pulse" />
            <p className="text-body text-ink-secondary">Confirming your email…</p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-6">
            <div className="w-14 h-14 bg-signal-rising/10 rounded-full flex items-center justify-center mx-auto">
              <Check className="w-7 h-7 text-signal-rising" />
            </div>
            <div>
              <h1 className="text-title text-ink mb-2">You're in.</h1>
              <p className="text-body text-ink-secondary">
                Your subscription is confirmed. Expect your first issue this Friday.
              </p>
            </div>

            {/* Referral link */}
            <div className="bg-surface-alt rounded-ive p-5 space-y-3">
              <p className="text-caption text-ink-secondary font-medium">
                Your referral link — share it to unlock bonus content:
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/r/${referralCode}`}
                  className="ive-input text-caption flex-1 bg-surface"
                />
                <button
                  onClick={copyLink}
                  className="ive-button !px-4 !py-3"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-caption text-ink-secondary">
                🎯 3 referrals → editorial takes &nbsp;·&nbsp; 10 referrals → deep dives
              </p>
            </div>

            <Link to="/" className="ive-button-secondary inline-flex">
              Back to home
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div className="w-14 h-14 bg-signal-breakout/10 rounded-full flex items-center justify-center mx-auto">
              <span className="text-2xl">⚠️</span>
            </div>
            <h1 className="text-title text-ink">Something went wrong</h1>
            <p className="text-body text-ink-secondary">{error}</p>
            <Link to="/" className="ive-button-secondary inline-flex">
              Back to home
            </Link>
          </div>
        )}
      </motion.div>
    </div>
  )
}
