import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, Check, TrendingUp, Sparkles, Eye, Share2, Lock } from 'lucide-react'
import { subscriberApi, signalApi, predictionApi } from '../lib/api'
import type { TrendingSignal, EditorialSignal, Prediction } from '../lib/api'

// ─── Animated Counter ────────────────────────────────────

function AnimatedCounter({ target, duration = 2000 }: { target: number; duration?: number }) {
  const [count, setCount] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const hasAnimated = useRef(false)

  useEffect(() => {
    if (hasAnimated.current || target === 0) return
    hasAnimated.current = true

    const start = 0
    const startTime = performance.now()

    function tick(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setCount(Math.floor(start + (target - start) * eased))
      if (progress < 1) requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  }, [target, duration])

  return <span ref={ref}>{count.toLocaleString()}</span>
}

// ─── Tier Badge ──────────────────────────────────────────

function TierBadge({ tier }: { tier: string }) {
  // Normalize tier string (handle both "breakout" and "🔥 Breakout" formats)
  const normalized = tier.toLowerCase().replace(/[🔥⚡📈⭐]/g, '').trim()
  
  const config: Record<string, { label: string; color: string; icon: string }> = {
    breakout: { label: 'Breakout', color: 'bg-signal-breakout/10 text-signal-breakout', icon: '🔥' },
    strong:   { label: 'Strong',   color: 'bg-signal-strong/10 text-signal-strong',     icon: '⚡' },
    signal:   { label: 'Rising',   color: 'bg-signal-rising/10 text-signal-rising',     icon: '📈' },
    rising:   { label: 'Rising',   color: 'bg-signal-rising/10 text-signal-rising',     icon: '📈' },
  }
  const c = config[normalized] || config.signal
  return (
    <span className={`ive-badge ${c.color}`}>
      <span>{c.icon}</span>
      {c.label}
    </span>
  )
}

// ─── Velocity Indicator ──────────────────────────────────

function Velocity({ pct }: { pct: number }) {
  const color = pct > 100 ? 'text-signal-breakout' : pct > 50 ? 'text-signal-strong' : 'text-signal-rising'
  return (
    <span className={`font-semibold text-caption ${color}`}>
      +{pct.toFixed(0)}%
    </span>
  )
}

// ─── Main Landing Page ───────────────────────────────────

export default function Landing() {
  const [searchParams] = useSearchParams()
  const ref = searchParams.get('ref') || undefined

  // Form state
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [showName, setShowName] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  // Data state
  const [subscriberCount, setSubscriberCount] = useState(0)
  const [goal] = useState(40000)
  const [trending, setTrending] = useState<TrendingSignal[]>([])
  const [editorial, setEditorial] = useState<EditorialSignal[]>([])
  const [prediction, setPrediction] = useState<Prediction | null>(null)

  // Load data on mount
  useEffect(() => {
    subscriberApi.count()
      .then(r => setSubscriberCount(r.count))
      .catch(() => setSubscriberCount(0))

    signalApi.trending(5)
      .then(r => setTrending(r.trending || []))
      .catch(() => {})

    predictionApi.latest()
      .then(r => setPrediction(r.prediction))
      .catch(() => {})

    // Try editorial (may be gated)
    signalApi.editorial(ref)
      .then(r => setEditorial(r.editorial || []))
      .catch(() => {})
  }, [ref])

  // Subscribe handler
  async function handleSubscribe(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return

    setSubmitting(true)
    setError('')

    try {
      await subscriberApi.subscribe({
        email,
        name: name || undefined,
        source: 'website',
        referral_code: ref,
      })
      setSubmitted(true)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* ─── Nav ─────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-surface/80 backdrop-blur-xl border-b border-ink-tertiary/30">
        <div className="ive-container flex items-center justify-between h-12">
          <a href="/" className="text-body font-semibold text-ink tracking-tight">
            Anti<span className="text-accent">Algo</span>.ai
          </a>
          <div className="flex items-center gap-6">
            <a href="#trending" className="text-caption text-ink-secondary hover:text-ink transition-colors">
              Trending
            </a>
            <a href="#subscribe" className="text-caption text-accent font-medium hover:underline">
              Subscribe
            </a>
          </div>
        </div>
      </nav>

      {/* ─── Hero ────────────────────────────────────── */}
      <section className="pt-32 pb-20 md:pt-44 md:pb-30">
        <div className="ive-container text-center">
          <motion.p
            className="text-eyebrow text-accent uppercase mb-4"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            The anti-algorithm newsletter
          </motion.p>

          <motion.h1
            className="text-headline md:text-display text-ink max-w-[800px] mx-auto mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            The algorithm decides what you see.
            <br />
            <em className="not-italic text-accent">We show you what it hides.</em>
          </motion.h1>

          <motion.p
            className="text-body-lg text-ink-secondary max-w-[600px] mx-auto mb-10"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            Every week, we surface the developer signals that algorithms bury —
            the breakouts, the contrarian takes, and one falsifiable prediction
            no feed will ever show you.
          </motion.p>

          {/* Subscribe form */}
          <motion.div
            className="max-w-[480px] mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            id="subscribe"
          >
            <AnimatePresence mode="wait">
              {submitted ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="ive-card text-center"
                >
                  <div className="w-12 h-12 bg-signal-rising/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="w-6 h-6 text-signal-rising" />
                  </div>
                  <h3 className="text-title mb-2">Check your inbox.</h3>
                  <p className="text-body text-ink-secondary">
                    We sent a confirmation link to <strong className="text-ink">{email}</strong>.
                    <br />Click it to activate your subscription.
                  </p>
                </motion.div>
              ) : (
                <motion.form
                  key="form"
                  onSubmit={handleSubscribe}
                  className="space-y-3"
                >
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      className="ive-input flex-1"
                      onFocus={() => setShowName(true)}
                    />
                    <button
                      type="submit"
                      disabled={submitting}
                      className="ive-button whitespace-nowrap"
                    >
                      {submitting ? (
                        <span className="animate-pulse-soft">Subscribing…</span>
                      ) : (
                        <>
                          Subscribe
                          <ArrowRight className="w-4 h-4 ml-2" />
                        </>
                      )}
                    </button>
                  </div>

                  <AnimatePresence>
                    {showName && (
                      <motion.input
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="First name (optional)"
                        className="ive-input"
                      />
                    )}
                  </AnimatePresence>

                  {error && (
                    <p className="text-caption text-signal-breakout">{error}</p>
                  )}

                  <p className="text-caption text-ink-secondary">
                    Free forever. One email per week. Unsubscribe anytime.
                  </p>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Social proof counter */}
          <motion.div
            className="mt-10 flex items-center justify-center gap-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            <div className="text-center">
              <p className="text-title text-ink">
                <AnimatedCounter target={subscriberCount} />
              </p>
              <p className="text-caption text-ink-secondary">subscribers</p>
            </div>
            <div className="w-px h-8 bg-ink-tertiary/50" />
            <div className="text-center">
              <p className="text-title text-ink">
                <AnimatedCounter target={goal} />
              </p>
              <p className="text-caption text-ink-secondary">goal</p>
            </div>
            <div className="w-px h-8 bg-ink-tertiary/50" />
            <div className="text-center">
              <p className="text-title text-accent">
                {subscriberCount > 0 ? ((subscriberCount / goal) * 100).toFixed(1) : '0'}%
              </p>
              <p className="text-caption text-ink-secondary">there</p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ─── Trending Signals ────────────────────────── */}
      <section id="trending" className="ive-section bg-surface-alt">
        <div className="ive-container">
          <div className="text-center mb-16">
            <p className="text-eyebrow text-accent uppercase mb-3">
              This week's signals
            </p>
            <h2 className="text-headline text-ink">
              What's trending now.
            </h2>
            <p className="text-body-lg text-ink-secondary mt-4 max-w-[500px] mx-auto">
              Signals the algorithm doesn't want you to see — updated weekly.
            </p>
          </div>

          <div className="grid gap-4 max-w-[720px] mx-auto">
            {trending.length > 0 ? trending.map((signal, i) => {
              const editorialItem = editorial.find(e => e.id === signal.id)
              return (
                <motion.div
                  key={signal.id}
                  className="ive-card flex items-start gap-4"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                >
                  <span className="text-headline text-ink-tertiary font-semibold w-8 shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <TierBadge tier={signal.tier} />
                      <Velocity pct={signal.velocity_pct} />
                    </div>
                    <h3 className="text-body font-semibold text-ink leading-snug">
                      {signal.canonical_question}
                    </h3>
                    <p className="text-caption text-ink-secondary mt-1">
                      {signal.question_count} questions · {signal.platform_count} platform{signal.platform_count !== 1 ? 's' : ''}
                    </p>

                    {/* Editorial take — unlocked by referrals */}
                    {editorialItem?.editorial_take ? (
                      <div className="mt-3 pt-3 border-t border-ink-tertiary/30">
                        <p className="text-caption text-ink-secondary flex items-center gap-1">
                          <Sparkles className="w-3 h-3 text-accent" />
                          <span className="font-medium text-accent">Jobs Take</span>
                        </p>
                        <p className="text-body text-ink mt-1 italic">
                          "{editorialItem.editorial_take}"
                        </p>
                      </div>
                    ) : editorial.length === 0 && i === 0 ? (
                      <div className="mt-3 pt-3 border-t border-ink-tertiary/30 flex items-center gap-2">
                        <Lock className="w-3 h-3 text-ink-secondary" />
                        <p className="text-caption text-ink-secondary">
                          <a href="#referral" className="text-accent hover:underline">
                            Refer 3 friends
                          </a>
                          {' '}to unlock editorial takes on each signal.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </motion.div>
              )
            }) : (
              // Skeleton loading
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="ive-card animate-pulse">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 bg-surface-alt rounded" />
                    <div className="flex-1 space-y-3">
                      <div className="h-4 bg-surface-alt rounded w-1/4" />
                      <div className="h-5 bg-surface-alt rounded w-3/4" />
                      <div className="h-3 bg-surface-alt rounded w-1/2" />
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* ─── Prediction ──────────────────────────────── */}
      {prediction && (
        <section className="ive-section">
          <div className="ive-container max-w-[720px]">
            <motion.div
              className="ive-card relative overflow-hidden"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-accent" />
              <div className="pl-6">
                <p className="text-eyebrow text-accent uppercase mb-3">
                  <Eye className="w-3 h-3 inline mr-1" />
                  Last week we predicted
                </p>
                <blockquote className="text-body-lg text-ink font-medium mb-4">
                  "{prediction.prediction_text}"
                </blockquote>
                {prediction.grade_display && (
                  <div className="flex items-center gap-3">
                    <span className="text-body font-semibold">
                      {prediction.grade_display}
                    </span>
                    {prediction.grade_explanation && (
                      <span className="text-caption text-ink-secondary">
                        — {prediction.grade_explanation}
                      </span>
                    )}
                  </div>
                )}
                {!prediction.grade_display && (
                  <p className="text-caption text-ink-secondary">
                    Confidence: {prediction.confidence} · Grading this week
                  </p>
                )}
              </div>
            </motion.div>
          </div>
        </section>
      )}

      {/* ─── How It Works ────────────────────────────── */}
      <section className="ive-section bg-surface-alt">
        <div className="ive-container">
          <div className="text-center mb-16">
            <h2 className="text-headline text-ink">How it works.</h2>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-[900px] mx-auto">
            {[
              {
                icon: '📡',
                title: 'Ingest',
                body: 'We scan thousands of developer questions from Reddit, Stack Exchange, and forums every week.',
              },
              {
                icon: '🧠',
                title: 'Detect',
                body: 'AI clusters related questions, scores velocity, and identifies breakout signals.',
              },
              {
                icon: '📰',
                title: 'Deliver',
                body: 'You get the top signals, one weird pick, and a falsifiable prediction — every Friday.',
              },
            ].map((step, i) => (
              <motion.div
                key={step.title}
                className="text-center"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15 }}
              >
                <span className="text-[40px] block mb-4">{step.icon}</span>
                <h3 className="text-title text-ink mb-2">{step.title}</h3>
                <p className="text-body text-ink-secondary">{step.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Referral Program ────────────────────────── */}
      <section id="referral" className="ive-section">
        <div className="ive-container max-w-[720px] text-center">
          <Share2 className="w-8 h-8 text-accent mx-auto mb-4" />
          <h2 className="text-headline text-ink mb-4">
            Share. Unlock more.
          </h2>
          <p className="text-body-lg text-ink-secondary mb-10 max-w-[500px] mx-auto">
            Every subscriber gets a unique referral link. Share it, and unlock
            bonus content as friends join.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              { count: 1, label: 'Early access to signals', icon: '⚡' },
              { count: 3, label: 'Steve Jobs editorial takes', icon: '🧠' },
              { count: 10, label: 'Deep-dive analysis PDFs', icon: '📊' },
            ].map((tier, i) => (
              <motion.div
                key={tier.count}
                className="ive-card text-center"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
              >
                <span className="text-[32px] block mb-2">{tier.icon}</span>
                <p className="text-title text-accent mb-1">{tier.count}+ referrals</p>
                <p className="text-caption text-ink-secondary">{tier.label}</p>
              </motion.div>
            ))}
          </div>

          <p className="text-caption text-ink-secondary mt-8">
            Your unique referral link is sent in your confirmation email.
          </p>
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────────── */}
      <section className="ive-section bg-ink text-white">
        <div className="ive-container text-center">
          <h2 className="text-headline text-white mb-4">
            Break free from the feed.
          </h2>
          <p className="text-body-lg text-white/70 mb-8 max-w-[480px] mx-auto">
            Join {subscriberCount > 0 ? subscriberCount.toLocaleString() : ''} developers who see what the algorithm won't show them.
          </p>
          <a
            href="#subscribe"
            className="ive-button bg-white text-ink hover:bg-white/90"
          >
            Subscribe — it's free
            <ArrowRight className="w-4 h-4 ml-2" />
          </a>
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────── */}
      <footer className="py-8 border-t border-ink-tertiary/30">
        <div className="ive-container flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-caption text-ink-secondary">
            © {new Date().getFullYear()} AntiAlgo.ai — Built with signal, not noise.
          </p>
          <div className="flex items-center gap-6">
            <a href="/newsletter/2026-W06" className="text-caption text-ink-secondary hover:text-ink transition-colors">
              Past Issues
            </a>
            <a href="/unsubscribe" className="text-caption text-ink-secondary hover:text-ink transition-colors">
              Unsubscribe
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
