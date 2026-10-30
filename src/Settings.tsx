import { useEffect, useState } from 'react'
import { useApp } from './store'
import { VAPID_PUBLIC_KEY } from './supabase'
import { medTitle, useToast } from './ui'

declare global { interface Window { __arisInstall?: Event & { prompt: () => Promise<void> } } }

export function Settings() {
  const { household, members, me, meds, prefs, session, updateMyName, updateHousehold, createInvitation, savePref, enablePush, signOut, online } = useApp()
  const [name, setName] = useState(me?.display_name ?? '')
  const [child, setChild] = useState(household?.child_name ?? '')
  const [weight, setWeight] = useState(household?.child_weight_kg?.toString() ?? '')
  const [code, setCode] = useState<string | null>(null)
  const [pushState, setPushState] = useState<string>(typeof Notification === 'undefined' ? 'no-soportado' : Notification.permission)
  const [canInstall, setCanInstall] = useState(Boolean(window.__arisInstall))
  const toast = useToast()

  useEffect(() => { const h = () => setCanInstall(Boolean(window.__arisInstall)); window.addEventListener('aris-install', h); return () => window.removeEventListener('aris-install', h) }, [])

  const link = code ? `${window.location.origin}${window.location.pathname}?join=${code}` : ''
  async function invite() { setCode(await createInvitation()) }
  async function share() {
    const text = `Únete al registro de medicación de ${household?.child_name}. Código: ${code}\n${link}`
    if (navigator.share) { try { await navigator.share({ title: 'Aris Med', text }); return } catch { /* cancelado */ } }
    await navigator.clipboard?.writeText(text); toast.show('Enlace copiado')
  }
  async function activatePush() {
    const e = await enablePush()
    setPushState(typeof Notification === 'undefined' ? 'no-soportado' : Notification.permission)
    toast.show(e ?? 'Notificaciones activadas en este teléfono')
  }
  async function localTest() {
    if (Notification.permission !== 'granted') { toast.show('Primero activa las notificaciones.'); return }
    const reg = await navigator.serviceWorker.ready
    await reg.showNotification('Aris Med · prueba', { body: 'Si ves esto, los avisos del sistema funcionan en este teléfono.', tag: 'aris-test', icon: './icon-192.png' })
  }
  const prefFor = (id: string) => prefs.find((p) => p.medication_id === id && p.user_id === session?.user.id)

  return (
    <div className="page" style={{ paddingTop: 20 }}>
      <h2 style={{ color: 'var(--navy)' }}>Ajustes</h2>

      <div className="card stack">
        <h2>Tu perfil</h2>
        <div className="muted">{session?.user.email}</div>
        <label className="field">Nombre que aparece en las tomas<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn small" disabled={!name.trim() || name === me?.display_name} onClick={async () => toast.show((await updateMyName(name)) ?? 'Nombre guardado')}>Guardar</button>
      </div>

      <div className="card stack">
        <h2>Hogar familiar</h2>
        <div className="muted">Miembros: {members.map((m) => m.display_name).join(' · ')}</div>
        <label className="field">Nombre de la niña<input className="input" value={child} onChange={(e) => setChild(e.target.value)} /></label>
        <label className="field">Peso indicado por la familia (kg) — solo informativo<input className="input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
        <div className="muted">La app no usa el peso para calcular ni cambiar dosis.</div>
        <button className="btn small" onClick={async () => toast.show((await updateHousehold({ child_name: child.trim() || 'Aris', child_weight_kg: weight ? Number(weight.replace(',', '.')) : null })) ?? 'Guardado')}>Guardar</button>
        {members.length < (household?.max_members ?? 2) && (
          <>
            <button className="btn gold" disabled={!online} onClick={() => void invite()}>Invitar al otro progenitor</button>
            {code && <><div className="code">{code}</div><div className="muted">Caduca en 7 días y solo sirve una vez. Con el enlace, la otra persona crea su cuenta y se une.</div>
              <button className="btn" onClick={() => void share()}>Compartir enlace (WhatsApp…)</button></>}
          </>
        )}
      </div>

      <div className="card stack">
        <h2>Recordatorios</h2>
        <div className="alert info">Solo pueden activarse para medicamentos con pauta y horario <b>verificados</b> y con horario fijo. Cada progenitor configura los suyos.</div>
        <div className="muted">Estado en este teléfono: <b>{pushState === 'granted' ? 'permiso concedido' : pushState === 'denied' ? 'bloqueadas' : pushState === 'no-soportado' ? 'no soportado' : 'sin permiso'}</b>{!VAPID_PUBLIC_KEY && ' · servidor push sin configurar'}</div>
        <button className="btn gold" onClick={() => void activatePush()}>Activar notificaciones en este teléfono</button>
        <button className="btn ghost" onClick={() => void localTest()}>Probar aviso del sistema</button>
        {meds.filter((m) => m.active).map((m) => {
          const p = prefFor(m.id)
          const allowed = m.verified && m.schedule_mode === 'scheduled'
          const base = { medication_id: m.id, enabled: p?.enabled ?? false, lead_minutes: p?.lead_minutes ?? 10, overdue_minutes: p?.overdue_minutes ?? 15 }
          const save = async (patch: Partial<typeof base>) => { const e = await savePref({ ...base, ...patch }); if (e) toast.show(e) }
          return (
            <div key={m.id} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <label className="switch"><b>{medTitle(m)}</b>
                <input type="checkbox" disabled={!allowed} checked={allowed && base.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
              </label>
              {!allowed && <div className="muted">{m.schedule_mode !== 'scheduled' ? 'Registro manual: sin horario fijo, no hay recordatorios.' : 'Verifica primero la pauta en «Pautas».'}</div>}
              {allowed && base.enabled && (
                <div className="row">
                  <label className="field" style={{ flex: 1 }}>Aviso previo (min)
                    <select className="input" value={base.lead_minutes} onChange={(e) => void save({ lead_minutes: Number(e.target.value) })}>{[0, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n === 0 ? 'ninguno' : n}</option>)}</select></label>
                  <label className="field" style={{ flex: 1 }}>Aviso si no se registra (min)
                    <select className="input" value={base.overdue_minutes} onChange={(e) => void save({ overdue_minutes: Number(e.target.value) })}>{[0, 10, 15, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? 'ninguno' : n}</option>)}</select></label>
                </div>
              )}
            </div>
          )
        })}
        <details>
          <summary>Limitaciones de las notificaciones en Android</summary>
          <ul className="muted">
            <li>Requieren permiso de notificaciones y la app instalada (o Chrome con el sitio permitido).</li>
            <li>Los avisos los envía el servidor aunque la app esté cerrada, pero Android puede retrasarlos (ahorro de batería, «no molestar», datos restringidos). <b>No son una alarma garantizada</b>.</li>
            <li>Si fuerzas el cierre de Chrome o desactivas las notificaciones del sitio, no llegarán.</li>
            <li>No se avisa de tomas ya registradas ni se repite un mismo aviso. Para dosis críticas, usa además una alarma del reloj del móvil.</li>
          </ul>
        </details>
      </div>

      <div className="card stack">
        <h2>Instalación</h2>
        {canInstall
          ? <button className="btn gold" onClick={() => void window.__arisInstall?.prompt()}>Instalar en la pantalla de inicio</button>
          : <div className="muted">En Chrome para Android: menú ⋮ → «Instalar aplicación» / «Añadir a pantalla de inicio».</div>}
      </div>

      <button className="btn ghost" onClick={() => void signOut()}>Cerrar sesión</button>
      <p className="muted" style={{ textAlign: 'center' }}>Aris Med 1.0 · Herramienta de registro; no es un sistema de prescripción ni sustituye al pediatra.</p>
      {toast.node}
    </div>
  )
}
