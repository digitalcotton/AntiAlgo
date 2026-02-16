import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { runsApi } from '@/lib/api'
import { format } from 'date-fns'
import { Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

export default function Runs() {
  const queryClient = useQueryClient()
  const [isCreating, setIsCreating] = useState(false)

  const { data: runs, isLoading, refetch } = useQuery({
    queryKey: ['runs'],
    queryFn: () => runsApi.list({ limit: 50 }),
  })

  const createRun = useMutation({
    mutationFn: runsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      setIsCreating(false)
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline Runs</h1>
          <p className="text-gray-500">History of all signal detection runs</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 bg-white border rounded-lg hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-4 py-2 text-white bg-primary-600 rounded-lg hover:bg-primary-700"
          >
            <Plus className="w-4 h-4" />
            New Run
          </button>
        </div>
      </div>

      {/* New Run Modal */}
      {isCreating && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold mb-4">Start New Run</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const formData = new FormData(e.currentTarget)
                createRun.mutate({
                  week: formData.get('week') as string || undefined,
                  dry_run: formData.get('dry_run') === 'on',
                })
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Week (optional)
                  </label>
                  <input
                    type="text"
                    name="week"
                    placeholder="YYYY-WNN (e.g., 2024-W05)"
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave blank to process current week
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="dry_run"
                    id="dry_run"
                    className="rounded"
                  />
                  <label htmlFor="dry_run" className="text-sm text-gray-700">
                    Dry run (don't save to database)
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createRun.isPending}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {createRun.isPending ? 'Starting...' : 'Start Run'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Runs Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Week
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Questions
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Clusters
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Signals
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Started
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Duration
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : runs?.length ? (
              runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Link
                      to={`/runs/${run.id}`}
                      className="text-primary-600 hover:text-primary-800 font-medium"
                    >
                      {run.week}
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                    {run.questions_ingested.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                    {run.clusters_created}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-900">
                    {run.signals_detected}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                    {run.started_at && format(new Date(run.started_at), 'MMM d, h:mm a')}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-500">
                    {run.completed_at && run.started_at
                      ? formatDuration(
                          new Date(run.completed_at).getTime() -
                            new Date(run.started_at).getTime()
                        )
                      : run.status === 'running'
                      ? 'In progress'
                      : '-'}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                  No runs yet. Click "New Run" to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}
