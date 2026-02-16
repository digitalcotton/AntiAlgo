import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tenantsApi } from '@/lib/api'
import { useAuthStore } from '../store/auth'
import { Key, Copy, Trash2, Eye, EyeOff } from 'lucide-react'

export default function Settings() {
  const { apiKey, setApiKey, tenant } = useAuthStore()
  const queryClient = useQueryClient()
  const [showApiKey, setShowApiKey] = useState(false)
  const [isCreatingKey, setIsCreatingKey] = useState(false)
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; name: string } | null>(null)

  const { data: usage } = useQuery({
    queryKey: ['usage'],
    queryFn: tenantsApi.getUsage,
  })

  const { data: apiKeys } = useQuery({
    queryKey: ['api-keys'],
    queryFn: tenantsApi.listApiKeys,
  })

  const createKeyMutation = useMutation({
    mutationFn: tenantsApi.createApiKey,
    onSuccess: (data) => {
      setNewKeyResult({ key: data.key, name: data.name })
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
      setIsCreatingKey(false)
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: tenantsApi.revokeApiKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
  })

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500">Manage your account and API keys</p>
      </div>

      {/* Tenant Info */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Account</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm text-gray-500">Organization</label>
            <p className="font-medium">{tenant?.name || 'Unknown'}</p>
          </div>
          <div>
            <label className="block text-sm text-gray-500">Plan</label>
            <p className="font-medium capitalize">{tenant?.plan || 'Free'}</p>
          </div>
        </div>
      </div>

      {/* Usage */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Usage This Week</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <UsageBar
            label="Pipeline Runs"
            used={usage?.runs.used || 0}
            limit={usage?.runs.limit || 1}
          />
          <UsageBar
            label="API Requests"
            used={usage?.api_requests.used || 0}
            limit={usage?.api_requests.limit || 100}
          />
        </div>
      </div>

      {/* API Key Configuration */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Dashboard API Key</h2>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey || ''}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="p-2 text-gray-500 hover:text-gray-700"
          >
            {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        </div>
        <p className="text-sm text-gray-500 mt-2">
          This key is used to authenticate dashboard requests. Create one below or use an existing key.
        </p>
      </div>

      {/* New Key Alert */}
      {newKeyResult && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6">
          <h3 className="font-semibold text-green-800 mb-2">
            API Key Created: {newKeyResult.name}
          </h3>
          <p className="text-sm text-green-700 mb-3">
            Copy this key now. You won't be able to see it again!
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-3 bg-white rounded border font-mono text-sm">
              {newKeyResult.key}
            </code>
            <button
              onClick={() => copyToClipboard(newKeyResult.key)}
              className="p-2 text-green-600 hover:text-green-800"
            >
              <Copy className="w-5 h-5" />
            </button>
          </div>
          <button
            onClick={() => setNewKeyResult(null)}
            className="mt-3 text-sm text-green-600 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* API Keys */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">API Keys</h2>
          <button
            onClick={() => setIsCreatingKey(true)}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Create Key
          </button>
        </div>

        {/* Create Key Modal */}
        {isCreatingKey && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
              <h3 className="text-lg font-semibold mb-4">Create API Key</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const formData = new FormData(e.currentTarget)
                  createKeyMutation.mutate({
                    name: formData.get('name') as string,
                    scopes: ['read', 'write'],
                  })
                }}
              >
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Key Name
                  </label>
                  <input
                    type="text"
                    name="name"
                    required
                    placeholder="e.g., Dashboard Access"
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button
                    type="button"
                    onClick={() => setIsCreatingKey(false)}
                    className="px-4 py-2 text-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={createKeyMutation.isPending}
                    className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                  >
                    {createKeyMutation.isPending ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Keys List */}
        <div className="space-y-3">
          {apiKeys?.length ? (
            apiKeys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <Key className="w-5 h-5 text-gray-400" />
                  <div>
                    <p className="font-medium">{key.name}</p>
                    <p className="text-sm text-gray-500">
                      Scopes: {key.scopes.join(', ')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => revokeKeyMutation.mutate(key.id)}
                  disabled={revokeKeyMutation.isPending}
                  className="p-2 text-red-500 hover:text-red-700 disabled:opacity-50"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            ))
          ) : (
            <p className="text-gray-500 text-center py-4">
              No API keys yet. Create one to get started.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string
  used: number
  limit: number
}) {
  const percentage = Math.min((used / limit) * 100, 100)
  const isNearLimit = percentage >= 80

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-500">{label}</span>
        <span className={isNearLimit ? 'text-red-600 font-medium' : 'text-gray-900'}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${
            isNearLimit ? 'bg-red-500' : 'bg-primary-500'
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
