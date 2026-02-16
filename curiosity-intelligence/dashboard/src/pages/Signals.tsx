import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { signalsApi } from '../lib/api'
import { Search, Filter } from 'lucide-react'
import { useState } from 'react'

export default function Signals() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState(searchParams.get('search') || '')
  
  const tier = searchParams.get('tier') || undefined
  const week = searchParams.get('week') || undefined
  const page = parseInt(searchParams.get('page') || '1', 10)

  const { data, isLoading } = useQuery({
    queryKey: ['signals', { tier, week, page, search: searchParams.get('search') }],
    queryFn: () =>
      signalsApi.list({
        tier,
        week,
        page,
        per_page: 20,
        search: searchParams.get('search') || undefined,
      }),
  })

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setSearchParams((prev) => {
      if (search) {
        prev.set('search', search)
      } else {
        prev.delete('search')
      }
      prev.set('page', '1')
      return prev
    })
  }

  const setFilter = (key: string, value: string | null) => {
    setSearchParams((prev) => {
      if (value) {
        prev.set(key, value)
      } else {
        prev.delete(key)
      }
      prev.set('page', '1')
      return prev
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Signals</h1>
        <p className="text-gray-500">Browse and search detected curiosity signals</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <form onSubmit={handleSearch} className="flex-1 max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search signals..."
              className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </form>

        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-gray-400" />
          <select
            value={tier || ''}
            onChange={(e) => setFilter('tier', e.target.value || null)}
            className="px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500"
          >
            <option value="">All tiers</option>
            <option value="breakout">Breakout</option>
            <option value="strong">Strong</option>
            <option value="signal">Signal</option>
          </select>
          <input
            type="text"
            value={week || ''}
            onChange={(e) => setFilter('week', e.target.value || null)}
            placeholder="Week (YYYY-WNN)"
            className="w-32 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      {/* Signals List */}
      <div className="bg-white rounded-lg shadow divide-y">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : data?.signals.length ? (
          data.signals.map((signal) => (
            <Link
              key={signal.id}
              to={`/signals/${signal.id}`}
              className="block p-4 hover:bg-gray-50"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900">
                    {signal.canonical_question}
                  </h3>
                  <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-500">
                    <span>Score: {(signal.final_score * 100).toFixed(0)}%</span>
                    <span>Velocity: +{signal.velocity_pct.toFixed(0)}%</span>
                    <span>{signal.question_count} questions</span>
                    <span className="text-gray-400">•</span>
                    <span>{signal.platforms.join(', ')}</span>
                    <span className="text-gray-400">•</span>
                    <span>{signal.week}</span>
                  </div>
                  {signal.news_trigger && (
                    <p className="mt-2 text-sm text-blue-600">
                      📰 {signal.news_trigger.headline} ({signal.news_trigger.source})
                    </p>
                  )}
                </div>
                <TierBadge tier={signal.tier} />
              </div>
            </Link>
          ))
        ) : (
          <div className="p-8 text-center text-gray-500">
            No signals found matching your criteria
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 20 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setFilter('page', String(page - 1))}
            disabled={page <= 1}
            className="px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="px-4 py-2 text-gray-500">
            Page {page} of {Math.ceil(data.total / 20)}
          </span>
          <button
            onClick={() => setFilter('page', String(page + 1))}
            disabled={page >= Math.ceil(data.total / 20)}
            className="px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const classes = {
    breakout: 'bg-orange-100 text-orange-700',
    strong: 'bg-blue-100 text-blue-700',
    signal: 'bg-gray-100 text-gray-700',
  }

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded ${classes[tier as keyof typeof classes] || 'bg-gray-100'}`}>
      {tier}
    </span>
  )
}
