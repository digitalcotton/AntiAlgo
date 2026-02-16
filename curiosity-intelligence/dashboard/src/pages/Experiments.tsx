import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { experimentsApi } from '@/lib/api'
import { FlaskConical, Check } from 'lucide-react'
import { useState } from 'react'

export default function Experiments() {
  const queryClient = useQueryClient()
  const [selectedExperiment, setSelectedExperiment] = useState<string | null>(null)

  const { data: experiments, isLoading } = useQuery({
    queryKey: ['experiments'],
    queryFn: experimentsApi.list,
  })

  const { data: assignments } = useQuery({
    queryKey: ['experiment-assignments'],
    queryFn: experimentsApi.getAssignments,
  })

  const overrideMutation = useMutation({
    mutationFn: ({ name, variant }: { name: string; variant: string }) =>
      experimentsApi.override(name, variant),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['experiment-assignments'] })
    },
  })

  const getAssignment = (name: string) =>
    assignments?.find((a) => a.experiment === name)

  if (isLoading) {
    return <div className="text-center py-8">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Experiments</h1>
        <p className="text-gray-500">A/B testing configuration and assignments</p>
      </div>

      {/* Current Assignments */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Your Current Assignments</h2>
        <div className="flex flex-wrap gap-3">
          {assignments?.length ? (
            assignments.map((assignment) => (
              <div
                key={assignment.experiment}
                className="px-4 py-2 bg-primary-50 text-primary-700 rounded-lg"
              >
                <span className="font-medium">{assignment.experiment}:</span>{' '}
                <span>{assignment.variant}</span>
              </div>
            ))
          ) : (
            <p className="text-gray-500">No active experiment assignments</p>
          )}
        </div>
      </div>

      {/* Experiments List */}
      <div className="space-y-4">
        {experiments?.map((experiment) => {
          const currentAssignment = getAssignment(experiment.name)
          const isSelected = selectedExperiment === experiment.name

          return (
            <div key={experiment.name} className="bg-white rounded-lg shadow">
              <div
                className="p-4 cursor-pointer hover:bg-gray-50"
                onClick={() =>
                  setSelectedExperiment(isSelected ? null : experiment.name)
                }
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`p-2 rounded-lg ${
                        experiment.is_active
                          ? 'bg-green-100 text-green-600'
                          : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      <FlaskConical className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-medium">{experiment.name}</h3>
                      <p className="text-sm text-gray-500">
                        {experiment.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {currentAssignment && (
                      <span className="px-2 py-1 text-xs font-medium bg-primary-100 text-primary-700 rounded">
                        {currentAssignment.variant}
                      </span>
                    )}
                    <span
                      className={`px-2 py-1 text-xs font-medium rounded ${
                        experiment.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {experiment.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              {isSelected && (
                <div className="p-4 border-t bg-gray-50">
                  <h4 className="font-medium mb-3">Variants</h4>
                  <div className="space-y-2">
                    {experiment.variants.map((variant) => (
                      <div
                        key={variant.name}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          currentAssignment?.variant === variant.name
                            ? 'border-primary-500 bg-primary-50'
                            : 'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {currentAssignment?.variant === variant.name && (
                            <Check className="w-4 h-4 text-primary-600" />
                          )}
                          <div>
                            <p className="font-medium">{variant.name}</p>
                            <p className="text-sm text-gray-500">
                              Weight: {(variant.weight * 100).toFixed(0)}%
                            </p>
                            {Object.keys(variant.config).length > 0 && (
                              <pre className="text-xs text-gray-500 mt-1">
                                {JSON.stringify(variant.config, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            overrideMutation.mutate({
                              name: experiment.name,
                              variant: variant.name,
                            })
                          }
                          disabled={
                            overrideMutation.isPending ||
                            currentAssignment?.variant === variant.name
                          }
                          className="px-3 py-1 text-sm bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          {currentAssignment?.variant === variant.name
                            ? 'Current'
                            : 'Override'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
