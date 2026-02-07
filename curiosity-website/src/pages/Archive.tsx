import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { archiveApi } from '../lib/api'
import type { NewsletterMeta } from '../lib/api'

export default function Archive() {
  const { week } = useParams<{ week: string }>()
  const [html, setHtml] = useState('')
  const [meta, setMeta] = useState<NewsletterMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!week) return
    setLoading(true)
    archiveApi.get(week)
      .then(r => {
        setHtml(r.html)
        setMeta(r.meta)
      })
      .catch(err => setError(err.message || 'Newsletter not found.'))
      .finally(() => setLoading(false))
  }, [week])

  return (
    <div className="min-h-screen bg-surface">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-surface/80 backdrop-blur-xl border-b border-ink-tertiary/30">
        <div className="ive-container flex items-center justify-between h-12">
          <Link to="/" className="text-body font-semibold text-ink tracking-tight">
            Anti<span className="text-accent">Algo</span>.ai
          </Link>
          <Link to="/#subscribe" className="text-caption text-accent font-medium hover:underline flex items-center gap-1">
            Subscribe <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </nav>

      <div className="pt-24 pb-20">
        <div className="ive-container">
          {loading ? (
            <div className="max-w-[720px] mx-auto space-y-6">
              <div className="h-6 bg-surface-alt rounded w-40 animate-pulse" />
              <div className="h-[600px] bg-surface-alt rounded-ive-lg animate-pulse" />
            </div>
          ) : error ? (
            <div className="max-w-[480px] mx-auto text-center py-20">
              <span className="text-[40px] block mb-4">📭</span>
              <h1 className="text-title text-ink mb-2">Issue not found</h1>
              <p className="text-body text-ink-secondary mb-6">{error}</p>
              <Link to="/" className="ive-button-secondary inline-flex">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to home
              </Link>
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-[720px] mx-auto"
            >
              {/* Meta bar */}
              {meta && (
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <p className="text-eyebrow text-accent uppercase">
                      Issue #{meta.issue_number} · {meta.week}
                    </p>
                  </div>
                  <Link
                    to="/#subscribe"
                    className="ive-button !text-caption !px-5 !py-2"
                  >
                    Subscribe for next issue
                  </Link>
                </div>
              )}

              {/* Newsletter content */}
              <div
                className="ive-card p-0 overflow-hidden"
                dangerouslySetInnerHTML={{ __html: html }}
              />

              {/* Bottom CTA */}
              <div className="text-center mt-12 py-12 border-t border-ink-tertiary/30">
                <h2 className="text-title text-ink mb-3">Want this in your inbox?</h2>
                <p className="text-body text-ink-secondary mb-6">
                  Get the next issue delivered every Friday.
                </p>
                <Link to="/#subscribe" className="ive-button inline-flex">
                  Subscribe — it's free
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  )
}
