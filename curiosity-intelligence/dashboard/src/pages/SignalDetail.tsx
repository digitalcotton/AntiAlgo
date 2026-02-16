import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { signalsApi } from '../lib/api'

export default function SignalDetail() {
  const { id } = useParams<{ id: string }>()
  const signalId = parseInt(id!, 10)

  const { data: signal, isLoading, error } = useQuery({
    queryKey: ['signal', signalId],
    queryFn: () => signalsApi.get(signalId),
    enabled: !isNaN(signalId),
  })

  if (isLoading) {
    return <div className="text-center py-8">Loading...</div>
  }

  if (error || !signal) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">Signal not found</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-start justify-between">
          <h1 className="text-2xl font-bold text-gray-900">
            {signal.canonical_question}
          </h1>
          <TierBadge tier={signal.tier} large />
        </div>
        <p className="text-gray-500 mt-2">
          Week {signal.week} • Run #{signal.run_id}
        </p>
      </div>

      {/* Score Breakdown */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Score Breakdown</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <ScoreItem label="Final Score" value={signal.final_score} />
          <ScoreItem label="Velocity" value={signal.velocity_score} />
          <ScoreItem label="Cross-Platform" value={signal.cross_platform_score} />
          <ScoreItem label="Engagement" value={signal.engagement_score} />
          <ScoreItem label="Novelty" value={signal.novelty_score} />
          <ScoreItem label="Weirdness Bonus" value={signal.weirdness_bonus} highlight />
        </div>
      </div>

      {/* Metrics */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <MetricItem label="Velocity" value={`+${signal.velocity_pct.toFixed(0)}%`} />
          <MetricItem label="Questions" value={signal.question_count.toString()} />
          <MetricItem label="Platforms" value={signal.platform_count.toString()} />
          <MetricItem label="Sources" value={signal.platforms.join(', ')} />
        </div>
      </div>

      {/* News Trigger */}
      {signal.news_trigger && (
        <div className="bg-blue-50 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-2">📰 News Trigger</h2>
          <p className="text-gray-900">{signal.news_trigger.headline}</p>
          <p className="text-sm text-gray-500 mt-1">
            Source: {signal.news_trigger.source}
            {signal.news_trigger.url && (
              <a
                href={signal.news_trigger.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-blue-600 hover:underline"
              >
                View article →
              </a>
            )}
          </p>
        </div>
      )}

      {/* Sample Questions */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Sample Questions</h2>
        <ul className="space-y-2">
          {signal.sample_questions.map((q, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-gray-400">•</span>
              <span className="text-gray-700">{q}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ScoreItem({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  const percentage = value * 100
  const barColor = highlight ? 'bg-purple-500' : 'bg-primary-500'

  return (
    <div>
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-bold">{percentage.toFixed(0)}%</p>
      <div className="h-2 bg-gray-200 rounded-full mt-2 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  )
}

function TierBadge({ tier, large }: { tier: string; large?: boolean }) {
  const classes = {
    breakout: 'bg-orange-100 text-orange-700',
    strong: 'bg-blue-100 text-blue-700',
    signal: 'bg-gray-100 text-gray-700',
  }

  return (
    <span
      className={`${large ? 'px-4 py-2 text-sm' : 'px-2 py-1 text-xs'} font-medium rounded ${
        classes[tier as keyof typeof classes] || 'bg-gray-100'
      }`}
    >
      {tier}
    </span>
  )
}
