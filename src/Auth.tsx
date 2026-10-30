import { useState } from 'react'
import { supabase, configured } from './supabase'
import { useApp } from './store'
import { DISCLAIMER } from './ui'

export function NotConfigured() {
  return (
    <div className="auth">
      <h1>Aris Med</h1>
      <div className="alert bad">
        <strong>Base de datos no configurada</strong>
        Esta copia de la aplicación no está conectada a Supabase, así que <b>no hay sincronización ni registros compartidos</b>.
        No se guarda ni se muestra ninguna toma. Sigue la guía del README (paso «Configurar Supabase») y vuelve a compilar con
        <code> VITE_SUPABASE_URL </code> y <code> VITE_SUPABASE_ANON_KEY</code>.
      </div>
      <p className="muted">{DISCLAIMER}</p>
    </div>
  )
}

export function AuthScreen() {
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in')
  const [email, setEmail] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'info' | 'bad'; text: string } | null>(null)

  if (!configured) return <NotConfigured />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pass })
        if (error) setMsg({ kind: 'bad', text: error.message === 'Invalid login credentials' ? 'Correo o contraseña incorrectos.' : error.message })
      } else if (mode === 'up') {
        if (pass.length < 8) { setMsg({ kind: 'bad', text: 'La contraseña debe tener al menos 8 caracteres.' }); return }
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password: pass })
        if (error) setMsg({ kind: 'bad', text: error.message })
        else if (!data.session) setMsg({ kind: 'info', text: 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.' })
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + window.location.pathname })
        setMsg(error ? { kind: 'bad', text: error.message } : { kind: 'info', text: 'Si el correo existe, recibirás un enlace para cambiar la contraseña.' })
      }
    } catch {
      setMsg({ kind: 'bad', text: 'No se pudo conectar. Comprueba tu conexión.' })
    } finally { setBusy(false) }
  }

  return (
    <form className="auth" onSubmit={submit}>
      <img className="logo" src="./icon.svg" alt="" />
      <h1>Aris Med</h1>
      <p className="muted">Registro compartido de medicación entre los dos progenitores.</p>
      <label className="field">Correo electrónico
        <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {mode !== 'reset' && (
        <label className="field">Contraseña
          <input className="input" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
      )}
      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}
      <button className="btn" disabled={busy}>{busy ? <span className="spinner" /> : mode === 'in' ? 'Entrar' : mode === 'up' ? 'Crear cuenta' : 'Enviar enlace'}</button>
      <div className="row between">
        {mode === 'in'
          ? <><button type="button" className="btn ghost small" onClick={() => setMode('up')}>Crear cuenta</button>
              <button type="button" className="btn ghost small" onClick={() => setMode('reset')}>Olvidé la contraseña</button></>
          : <button type="button" className="btn ghost small" onClick={() => setMode('in')}>Volver</button>}
      </div>
      <p className="muted">{DISCLAIMER}</p>
    </form>
  )
}

export function HouseholdSetup() {
  const { createHousehold, acceptInvitation, signOut, session } = useApp()
  const joinParam = new URLSearchParams(window.location.search).get('join') ?? ''
  const [tab, setTab] = useState<'create' | 'join'>(joinParam ? 'join' : 'create')
  const [name, setName] = useState('')
  const [child, setChild] = useState('Aris')
  const [code, setCode] = useState(joinParam)
  const [family, setFamily] = useState('Familia')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function go() {
    setBusy(true); setErr(null)
    const r = tab === 'create' ? await createHousehold(family, child, name) : await acceptInvitation(code, name)
    setBusy(false)
    if (r) setErr(r)
    else if (joinParam) window.history.replaceState({}, '', window.location.pathname)
  }

  return (
    <div className="auth">
      <h1>Hogar familiar</h1>
      <p className="muted">Sesión: {session?.user.email}</p>
      <div className="seg">
        <button className={tab === 'create' ? 'on' : ''} onClick={() => setTab('create')}>Crear hogar</button>
        <button className={tab === 'join' ? 'on' : ''} onClick={() => setTab('join')}>Tengo un código</button>
      </div>
      <label className="field">Tu nombre (así aparecerá en cada toma)
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Carlos / Mireia" maxLength={40} />
      </label>
      {tab === 'create' ? (
        <>
          <label className="field">Nombre de la niña
            <input className="input" value={child} onChange={(e) => setChild(e.target.value)} />
          </label>
          <label className="field">Nombre del hogar
            <input className="input" value={family} onChange={(e) => setFamily(e.target.value)} />
          </label>
          <div className="alert info">Se cargará la medicación de la receta del 29/10/2026 como configuración inicial. <b>Debe verificarse con el profesional sanitario</b> antes de activar recordatorios.</div>
        </>
      ) : (
        <label className="field">Código de invitación
          <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" />
        </label>
      )}
      {err && <div className="alert bad">{err}</div>}
      <button className="btn" disabled={busy || !name.trim() || (tab === 'join' && !code.trim())} onClick={go}>
        {busy ? <span className="spinner" /> : tab === 'create' ? 'Crear hogar' : 'Unirme'}
      </button>
      <button className="btn ghost small" onClick={() => void signOut()}>Cerrar sesión</button>
    </div>
  )
}
