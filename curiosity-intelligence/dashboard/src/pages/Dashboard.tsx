import { useQuery } from '@tanstack/react-query'
import { runsApi, signalsApi, tenantsApi } from '@/lib/api'
import { format } from 'date-fns'
import { 
  TrendingUp, 
  Zap, 
  Play, 
  AlertCircle 
} from 'lucide-react'

export default function Dashboard() {
  const { data: usage } = useQuery({
    queryKey: ['usage'],
    queryFn: tenantsApi.getUsage,
  })

  const { data: runs } = useQuery({
    queryKey: ['runs', { limit: 5 }],
    queryFn: () => runsApi.list({ limit: 5 }),
  })

  const { data: trending } = useQuery({
    queryKey: ['trending'],
    queryFn: () => signalsApi.getTrending(5),
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500">Overview of your curiosity signal detection</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Runs This Week"
          value={usage?.runs.used ?? 0}
          subtitle={`of ${usage?.runs.limit ?? 0} limit`}
          icon={Play}
          color="blue"
        />
        <StatCard
          title="Questions Ingested"
          value={usage?.questions_ingested ?? 0}
          subtitle="total processed"
          icon={TrendingUp}
          color="green"
        />
        <StatCard
          title="Signals Detected"
          value={usage?.signals_detected ?? 0}
          subtitle="across all runs"
          icon={Zap}
          color="yellow"
        />
        <StatCard
          title="API Requests"
          value={usage?.api_requests.used ?? 0}
          subtitle={`of ${usage?.api_requests.limit ?? 0} limit`}
          icon={AlertCircle}
          color="purple"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Runs */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Recent Runs</h2>
          <div className="space-y-3">
            {runs?.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div>
                  <p className="font-medium">{run.week}</p>
                  <p className="text-sm text-gray-500">
                    {run.started_at && format(new Date(run.started_at), 'MMM d, h:mm a')}
                  </p>
                </div>
                <div className="text-right">
                  <StatusBadge status={run.status} />
                  <p className="text-sm text-gray-500 mt-1">
                    {run.signals_detected} signals
                  </p>
                </div>
              </div>
            ))}
            {!runs?.length && (
              <p className="text-gray-500 text-center py-4">No runs yet</p>
            )}
          </div>
        </div>

        {/* Trending Signals */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Trending Signals</h2>
          <div className="space-y-3">
            {trending?.trending.map((signal, i) => (
              <div
                key={i}
                className="flex items-start gap-3 py-2 border-b last:border-0"
              >
                <div className="flex-1">
                  <p className="font-medium text-sm">{signal.canonical_question}</p>
                  <div className="flex gap-2 mt-1">
                    <span className="text-xs text-gray-500">
                      +{signal.velocity_pct}% velocity
                    </span>
                  </div>
                </div>
                <TierBadge tier={signal.tier} />
              </div>
            ))}
            {!trending?.trending.length && (
              <p className="text-gray-500 text-center py-4">No trending signals</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
}: {
  title: string
  value: number
  subtitle: string
  icon: React.ElementType
  color: 'blue' | 'green' | 'yellow' | 'purple'
}) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    purple: 'bg-purple-50 text-purple-600',
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-2xl font-bold">{value.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{subtitle}</p>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const classes = {
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  }

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded ${classes[status as keyof typeof classes] || 'bg-gray-100'}`}>
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
