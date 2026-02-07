import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Share2, Check, Copy, Lock, Sparkles } from 'lucide-react'
import { subscriberApi } from '../lib/api'
import type { ReferralStats } from '../lib/api'

const TIERS = [
  { min: 1, label: 'Early signal access', icon: '⚡', unlocked: false },
  { min: 3, label: 'Steve Jobs editorial takes', icon: '🧠', unlocked: false },
  { min: 10, label: 'Deep-dive analysis PDFs', icon: '📊', unlocked: false },
]

export default function Referral() {
  const { code } = useParams<{ code: string }>()
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const shareLink = `${window.location.origin}/r/${code}`

  useEffect(() => {
    if (!code) return
    subscriberApi.referralStats(code)
      .then(r => setStats(r))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [code])

  function copyLink() {
    navigator.clipboard.writeText(shareLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const referralCount = stats?.referral_count || 0

  return (
    <div className="min-h-screen bg-surface">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-surface/80 backdrop-blur-xl border-b border-ink-tertiary/30">
        <div className="ive-container flex items-center justify-between h-12">
          <Link to="/" className="text-body font-semibold text-ink tracking-tight">
            Anti<span className="text-accent">Algo</span>.ai
          </Link>
        </div>
      </nav>

      <div className="pt-32 pb-20">
        <div className="ive-container max-w-[600px]">
          {loading ? (
            <div className="ive-card animate-pulse space-y-4">
              <div className="h-8 bg-surface-alt rounded w-1/2 mx-auto" />
              <div className="h-4 bg-surface-alt rounded w-3/4 mx-auto" />
            </div>
          ) : stats ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {/* Hero */}
              <div className="text-center">
                <Share2 className="w-10 h-10 text-accent mx-auto mb-4" />
                <h1 className="text-headline text-ink mb-2">
                  {stats.name ? `${stats.name}'s` : 'Your'} referrals
                </h1>
                <p className="text-body-lg text-ink-secondary">
                  <span className="text-accent font-semibold">{referralCount}</span> friend{referralCount !== 1 ? 's' : ''} joined through your link
                </p>
              </div>

              {/* Share link */}
              <div className="ive-card">
                <p className="text-caption text-ink-secondary font-medium mb-3">
                  Your referral link
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={shareLink}
                    className="ive-input text-caption flex-1"
                  />
                  <button onClick={copyLink} className="ive-button !px-4 !py-3">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Tier progress */}
              <div className="space-y-3">
                <p className="text-eyebrow text-ink-secondary uppercase">Rewards progress</p>
                {TIERS.map(tier => {
                  const unlocked = referralCount >= tier.min
                  return (
                    <div
                      key={tier.min}
                      className={`ive-card flex items-center gap-4 ${unlocked ? 'ring-2 ring-accent/20' : 'opacity-60'}`}
                    >
                      <span className="text-2xl">{tier.icon}</span>
                      <div className="flex-1">
                        <p className="text-body font-medium text-ink">{tier.label}</p>
                        <p className="text-caption text-ink-secondary">
                          {tier.min} referral{tier.min !== 1 ? 's' : ''} needed
                        </p>
                      </div>
                      {unlocked ? (
                        <span className="ive-badge bg-signal-rising/10 text-signal-rising">
                          <Sparkles className="w-3 h-3" /> Unlocked
                        </span>
                      ) : (
                        <Lock className="w-4 h-4 text-ink-tertiary" />
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Not subscribed yet? CTA */}
              <div className="text-center pt-4">
                <p className="text-body text-ink-secondary mb-4">
                  Not subscribed yet? Join through this link to help {stats.name || 'the referrer'}.
                </p>
                <Link
                  to={`/?ref=${code}`}
                  className="ive-button inline-flex"
                >
                  Subscribe now
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </div>
            </motion.div>
          ) : (
            <div className="ive-card text-center">
              <span className="text-[40px] block mb-4">🤔</span>
              <h1 className="text-title text-ink mb-2">Referral not found</h1>
              <p className="text-body text-ink-secondary mb-6">
                This referral link doesn't seem to be valid.
              </p>
              <Link to="/" className="ive-button-secondary inline-flex">
                Go to homepage
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
