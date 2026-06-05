import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { useAuthStore } from '@/hooks/useAuth'
import RequireAuth from '@/components/RequireAuth'
import Layout from '@/components/Layout'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import ServerDetail from '@/pages/ServerDetail'
import Settings from '@/pages/Settings'
import History from '@/pages/History'
import Templates from '@/pages/Templates'
import Compare from '@/pages/Compare'
import Search from '@/pages/Search'
import Reports from '@/pages/Reports'
import Security from '@/pages/Security'

// Keyed by :id so navigating between servers (e.g. via the command palette) fully
// remounts ServerDetail and all its tab children. Without this, react-router reuses
// the same element across param changes, leaving per-tab state (notably the Apt Repos
// editor) pointing at the previous server — which could save server A's repo files
// onto server B.
function ServerDetailRoute() {
  const { id } = useParams()
  return <ServerDetail key={id} />
}

export default function App() {
  const { init } = useAuthStore()

  useEffect(() => {
    init()
  }, [init])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout>
                <Dashboard />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/servers/:id"
          element={
            <RequireAuth>
              <Layout>
                <ServerDetailRoute />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <Layout>
                <Settings />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/history"
          element={
            <RequireAuth>
              <Layout>
                <History />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/templates"
          element={
            <RequireAuth>
              <Layout>
                <Templates />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/compare"
          element={
            <RequireAuth>
              <Layout>
                <Compare />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/search"
          element={
            <RequireAuth>
              <Layout>
                <Search />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireAuth>
              <Layout>
                <Reports />
              </Layout>
            </RequireAuth>
          }
        />
        <Route
          path="/security"
          element={
            <RequireAuth>
              <Layout>
                <Security />
              </Layout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
