import { Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing'
import Confirm from './pages/Confirm'
import Unsubscribe from './pages/Unsubscribe'
import Referral from './pages/Referral'
import Archive from './pages/Archive'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/confirm/:token" element={<Confirm />} />
      <Route path="/unsubscribe" element={<Unsubscribe />} />
      <Route path="/r/:code" element={<Referral />} />
      <Route path="/newsletter/:week" element={<Archive />} />
    </Routes>
  )
}

export default App
