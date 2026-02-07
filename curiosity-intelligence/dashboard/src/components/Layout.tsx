import { NavLink, Outlet } from 'react-router-dom'
import { 
  LayoutDashboard, 
  Play, 
  Zap, 
  FlaskConical, 
  Settings,
  LogOut 
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import clsx from 'clsx'

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Runs', href: '/runs', icon: Play },
  { name: 'Signals', href: '/signals', icon: Zap },
  { name: 'Experiments', href: '/experiments', icon: FlaskConical },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Layout() {
  const { tenant, logout } = useAuthStore()

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-xl font-bold">Curiosity Intel</h1>
          <p className="text-sm text-gray-400">Signal Detection Dashboard</p>
        </div>
        
        <nav className="flex-1 p-4 space-y-1">
          {navigation.map((item) => (
            <NavLink
              key={item.name}
              to={item.href}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800'
                )
              }
              end={item.href === '/'}
            >
              <item.icon className="w-5 h-5" />
              {item.name}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-800">
          {tenant && (
            <div className="mb-3">
              <p className="text-sm font-medium">{tenant.name}</p>
              <p className="text-xs text-gray-400 capitalize">{tenant.plan} plan</p>
            </div>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
