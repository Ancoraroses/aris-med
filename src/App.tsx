import { useEffect, useState } from 'react'
import { AppProvider, useApp } from './store'
import { AuthScreen, HouseholdSetup, NotConfigured } from './Auth'
import { Home } from './Home'
import { History } from './History'
import { Meds } from './Meds'
import { Settings } from './Settings'
import { DISCLAIMER } from './ui'

type Tab = 'home' | 'hist' | 'meds' | 'settings'

function Shell() {
  const { configured, session, authReady, loading, household } = useApp()
  const [tab, setTab] = useState<Tab>('home')

  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); window.__arisInstall = e as never; window.dispatchEvent(new Event('aris-install')) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])

  if (!configured) return <NotConfigured />
  if (!authReady) return <div className="auth"><span className="muted">Cargando…</span></div>
  if (!session) return <AuthScreen />
  if (loading && !household) return <div className="auth"><span className="muted">Sincronizando…</span></div>
  if (!household) return <HouseholdSetup />

  const tabs: { id: Tab; ico: string; label: string }[] = [
    { id: 'home', ico: '🏠', label: 'Inicio' },
    { id: 'hist', ico: '📋', label: 'Historial' },
    { id: 'meds', ico: '💊', label: 'Pautas' },
    { id: 'settings', ico: '⚙️', label: 'Ajustes' }
  ]
  return (
    <div className="app">
      <div className="banner">{DISCLAIMER}</div>
      {tab === 'home' && <Home goto={(t) => setTab(t)} />}
      {tab === 'hist' && <History />}
      {tab === 'meds' && <Meds />}
      {tab === 'settings' && <Settings />}
      <nav className="tabbar" aria-label="Navegación">
        <div className="tabbar-inner">
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => { setTab(t.id); window.scrollTo(0, 0) }}>
              <span className="ico" aria-hidden>{t.ico}</span>{t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

export default function App() {
  return <AppProvider><Shell /></AppProvider>
}
