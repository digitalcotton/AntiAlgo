import { createContext, useContext, useState, useEffect } from 'react'

interface AuthContextType {
  isAuthenticated: boolean
  login: (password: string) => boolean
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  // Check if already authenticated on mount (from localStorage)
  useEffect(() => {
    const token = localStorage.getItem('dashboard_auth')
    if (token) {
      setIsAuthenticated(true)
    }
  }, [])

  const login = (password: string): boolean => {
    const correctPassword = import.meta.env.VITE_DASHBOARD_PASSWORD || 'dashboard123'
    if (password === correctPassword) {
      localStorage.setItem('dashboard_auth', 'true')
      setIsAuthenticated(true)
      return true
    }
    return false
  }

  const logout = () => {
    localStorage.removeItem('dashboard_auth')
    setIsAuthenticated(false)
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
