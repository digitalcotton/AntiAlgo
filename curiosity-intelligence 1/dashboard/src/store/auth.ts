import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  apiKey: string | null
  tenant: Tenant | null
  setApiKey: (key: string) => void
  setTenant: (tenant: Tenant) => void
  logout: () => void
}

interface Tenant {
  id: number
  name: string
  plan: string
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      apiKey: null,
      tenant: null,
      setApiKey: (apiKey) => set({ apiKey }),
      setTenant: (tenant) => set({ tenant }),
      logout: () => set({ apiKey: null, tenant: null }),
    }),
    {
      name: 'curiosity-auth',
    }
  )
)
