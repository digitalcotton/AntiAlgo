import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { runsApi } from '@/lib/api'
import { format } from 'date-fns'

export default function RunDetail() {
  const { id } = useParams<{ id: string }>()
  const runId = parseInt(id!, 10)

  const { data: run, isLoading } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId),
    enabled: !isNaN(runId),
  })

  const { data: signals } = useQuery({
    queryKey: ['run', runId, 'signals'],
    queryFn: () => runsApi.getSignals(runId),
    enabled: !isNaN(runId),
  })

  if (isLoading) {
    return <div className="text-center py-8">Loading...</div>
  }

  if (!run) {
    return <div className="text-center py-8">Run not found</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Run: {run.week}</h1>
          <p className="text-gray-500">
            Started {run.started_at && format(new Date(run.started_at), 'MMMM d, yyyy h:mm a')}
          </p>
        </div>
        <StatusBadge status={run.status} large />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard label="Questions Ingested" value={run.questions_ingested} />
        <StatCard label="Clusters Created" value={run.clusters_created} />
        <StatCard label="Signals Detected" value={run.signals_detected} />
        <StatCard
          label="Duration"
          value={
            run.completed_at && run.started_at
              ? formatDuration(
                  new Date(run.completed_at).getTime() -
                    new Date(run.started_at).getTime()
                )
              : 'In progress'
          }
          isText
        />
      </div>

      {/* Experiment Assignments */}
      {run.experiment_assignments && Object.keys(run.experiment_assignments).length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Experiment Assignments</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(run.experiment_assignments).map(([exp, variant]) => (
              <div
                key={exp}
                className="px-3 py-2 bg-gray-100 rounded-lg text-sm"
              >
                <span className="font-medium">{exp}:</span>{' '}
                <span className="text-gray-600">{variant as string}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Signals */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Detected Signals</h2>
        {signals?.signals.length ? (
          <div className="space-y-4">
            {signals.signals.map((signal) => (
              <div
                key={signal.id}
                className="border rounded-lg p-4 hover:bg-gray-50"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-medium">{signal.canonical_question}</h3>
                    <div className="flex gap-4 mt-2 text-sm text-gray-500">
                      <span>Score: {(signal.final_score * 100).toFixed(0)}%</span>
                      <span>Velocity: +{signal.velocity_pct.toFixed(0)}%</span>
                      <span>{signal.question_count} questions</span>
                      <span>{signal.platforms.join(', ')}</span>
                    </div>
                    {signal.news_trigger && (
                      <div className="mt-2 text-sm">
                        <span className="text-gray-400">News trigger: </span>
                        <span className="text-gray-600">{signal.news_trigger.headline}</span>
                      </div>
                    )}
                  </div>
                  <TierBadge tier={signal.tier} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-center py-4">No signals detected</p>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, isText }: { label: string; value: number | string; isText?: boolean }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold mt-1">
        {isText ? value : (value as number).toLocaleString()}
      </p>
    </div>
  )
}

function StatusBadge({ status, large }: { status: string; large?: boolean }) {
  const classes = {
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  }

  return (
    <span
      className={`${large ? 'px-4 py-2 text-sm' : 'px-2 py-1 text-xs'} font-medium rounded ${
        classes[status as keyof typeof classes] || 'bg-gray-100'
      }`}
    >
      {status}
    </span>
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}
