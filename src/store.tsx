import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, configured, VAPID_PUBLIC_KEY } from './supabase'
import type {
  DoseHistoryEntry, DoseLog, Household, Incident, Medication, Member, NotifPref, PendingOp, RpcResult
} from './types'

const OUTBOX_KEY = 'aris_outbox_v1'
const CONFLICTS_KEY = 'aris_outbox_conflicts_v1'

function readLS<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback } catch { return fallback }
}
function writeLS(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* almacenamiento no disponible */ }
}

export interface OutboxConflict { op: PendingOp; code: string; at: string }

export interface RegisterInput {
  medication: Medication
  scheduled_for: string | null
  administered_at: string
  dose_text: string
  notes: string | null
  status: 'given' | 'skipped'
  time_confirmed: boolean
  given_by: string | null
  given_by_name: string
  force: boolean
}
export type RegisterOutcome =
  | { kind: 'ok'; log: DoseLog }
  | { kind: 'conflict'; code: string; log?: DoseLog }
  | { kind: 'queued' }
  | { kind: 'error'; message: string }

interface AppState {
  configured: boolean
  session: Session | null
  authReady: boolean
  loading: boolean
  household: Household | null
  members: Member[]
  me: Member | null
  meds: Medication[]
  logs: DoseLog[]
  incidents: Incident[]
  prefs: NotifPref[]
  outbox: PendingOp[]
  conflicts: OutboxConflict[]
  online: boolean
  lastSync: Date | null
  syncError: string | null
  now: Date
  refresh: () => Promise<void>
  registerDose: (i: RegisterInput) => Promise<RegisterOutcome>
  flushOutbox: () => Promise<void>
  dismissConflict: (opId: string) => void
  discardOp: (opId: string) => void
  correctDose: (log: DoseLog, p: { administered_at: string | null; dose_text: string; notes: string; status: string; time_confirmed: boolean; reason: string }) => Promise<RpcResult | { ok: false; code: 'network' }>
  voidDose: (log: DoseLog, reason: string) => Promise<RpcResult | { ok: false; code: 'network' }>
  loadHistory: (logId: string) => Promise<DoseHistoryEntry[]>
  addIncident: (p: { medication_id: string | null; kind: string; description: string; occurred_at: string }) => Promise<string | null>
  updateMedication: (id: string, patch: Partial<Medication>) => Promise<string | null>
  verifyMedication: (id: string, verified: boolean, note: string) => Promise<string | null>
  savePref: (p: Omit<NotifPref, 'user_id' | 'household_id'>) => Promise<string | null>
  updateHousehold: (patch: { child_name?: string; child_weight_kg?: number | null; name?: string }) => Promise<string | null>
  updateMyName: (name: string) => Promise<string | null>
  createInvitation: () => Promise<string | null>
  createHousehold: (family: string, child: string, myName: string) => Promise<string | null>
  acceptInvitation: (code: string, myName: string) => Promise<string | null>
  enablePush: () => Promise<string | null>
  signOut: () => Promise<void>
}

const Ctx = createContext<AppState | null>(null)
export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp fuera de AppProvider')
  return v
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!configured)
  const [loading, setLoading] = useState(false)
  const [household, setHousehold] = useState<Household | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [meds, setMeds] = useState<Medication[]>([])
  const [logs, setLogs] = useState<DoseLog[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [prefs, setPrefs] = useState<NotifPref[]>([])
  const [outbox, setOutbox] = useState<PendingOp[]>(() => readLS<PendingOp[]>(OUTBOX_KEY, []))
  const [conflicts, setConflicts] = useState<OutboxConflict[]>(() => readLS<OutboxConflict[]>(CONFLICTS_KEY, []))
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())
  const flushing = useRef(false)

  // ───── Autenticación ─────
  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // reloj
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(t)
  }, [])

  // ───── Carga de datos ─────
  const refresh = useCallback(async () => {
    if (!configured || !session) return
    try {
      const { data: mem, error: e1 } = await supabase.from('household_members').select('*')
      if (e1) throw e1
      const mine = (mem ?? []).find((m) => m.user_id === session.user.id)
      if (!mine) { setHousehold(null); setMembers([]); setMeds([]); setLogs([]); setIncidents([]); setLastSync(new Date()); setSyncError(null); return }
      const hid = mine.household_id as string
      const [h, m, l, i, p] = await Promise.all([
        supabase.from('households').select('*').eq('id', hid).single(),
        supabase.from('medications').select('*').eq('household_id', hid).order('sort_order'),
        supabase.from('dose_logs').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(2000),
        supabase.from('incidents').select('*').eq('household_id', hid).order('occurred_at', { ascending: false }).limit(500),
        supabase.from('notification_prefs').select('*').eq('household_id', hid)
      ])
      for (const r of [h, m, l, i, p]) if (r.error) throw r.error
      setMembers(mem as Member[])
      setHousehold(h.data as Household)
      setMeds(m.data as Medication[])
      setLogs(l.data as DoseLog[])
      setIncidents(i.data as Incident[])
      setPrefs(p.data as NotifPref[])
      setLastSync(new Date())
      setSyncError(null)
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e))
    }
  }, [session])

  useEffect(() => {
    if (!session) { setHousehold(null); setMeds([]); setLogs([]); setMembers([]); return }
    setLoading(true)
    refresh().finally(() => setLoading(false))
  }, [session, refresh])

  // Tiempo real + reintentos
  const hid = household?.id
  useEffect(() => {
    if (!configured || !session || !hid) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const debounced = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh() }, 250) }
    const ch = supabase.channel('aris-' + hid)
    for (const table of ['dose_logs', 'medications', 'incidents', 'household_members', 'households']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, debounced)
    }
    ch.subscribe()
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 60_000)
    const onVis = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearTimeout(timer); clearInterval(poll); document.removeEventListener('visibilitychange', onVis); void supabase.removeChannel(ch) }
  }, [session, hid, refresh])

  // ───── Cola de envío (pérdida de conexión) ─────
  const saveOutbox = (o: PendingOp[]) => { setOutbox(o); writeLS(OUTBOX_KEY, o) }
  const saveConflicts = (c: OutboxConflict[]) => { setConflicts(c); writeLS(CONFLICTS_KEY, c) }

  const callRegister = useCallback(async (op: PendingOp) => {
    return supabase.rpc('register_dose', {
      p_medication_id: op.medication_id,
      p_scheduled_for: op.scheduled_for,
      p_administered_at: op.administered_at,
      p_dose_text: op.dose_text,
      p_notes: op.notes,
      p_status: op.status,
      p_time_confirmed: op.time_confirmed,
      p_client_op_id: op.op_id,
      p_force: op.force,
      p_given_by: op.given_by
    })
  }, [])

  const flushOutbox = useCallback(async () => {
    if (flushing.current || !session) return
    const current = readLS<PendingOp[]>(OUTBOX_KEY, [])
    if (current.length === 0) return
    flushing.current = true
    try {
      let rest = [...current]
      let conf = readLS<OutboxConflict[]>(CONFLICTS_KEY, [])
      for (const op of current) {
        const { data, error } = await callRegister(op)
        if (error && !error.code) break // sigue sin red: se conserva todo
        rest = rest.filter((o) => o.op_id !== op.op_id)
        const res = data as RpcResult | null
        if (error || !res || !res.ok) {
          conf = [{ op, code: error ? error.message : res?.code ?? 'error', at: new Date().toISOString() }, ...conf]
        }
      }
      saveOutbox(rest)
      saveConflicts(conf)
      await refresh()
    } finally { flushing.current = false }
  }, [session, callRegister, refresh])

  useEffect(() => {
    const on = () => { setOnline(true); void flushOutbox(); void refresh() }
    const off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [flushOutbox, refresh])

  useEffect(() => { if (session && outbox.length) void flushOutbox() }, [session]) // eslint-disable-line react-hooks/exhaustive-deps

  // ───── Acciones ─────
  const registerDose = useCallback(async (i: RegisterInput): Promise<RegisterOutcome> => {
    const op: PendingOp = {
      op_id: crypto.randomUUID(),
      medication_id: i.medication.id,
      medication_name: i.medication.name,
      scheduled_for: i.scheduled_for,
      administered_at: i.administered_at,
      dose_text: i.dose_text,
      notes: i.notes,
      status: i.status,
      time_confirmed: i.time_confirmed,
      given_by: i.given_by,
      given_by_name: i.given_by_name,
      force: i.force,
      queued_at: new Date().toISOString()
    }
    const { data, error } = await callRegister(op)
    if (error) {
      if (!error.code) { // sin red: se guarda en cola, pero NO se muestra como administrada
        saveOutbox([...readLS<PendingOp[]>(OUTBOX_KEY, []), op])
        return { kind: 'queued' }
      }
      return { kind: 'error', message: error.message }
    }
    const res = data as RpcResult
    if (!res.ok) return { kind: 'conflict', code: res.code ?? 'error', log: res.log }
    await refresh() // el estado "administrada" solo aparece cuando el servidor lo ha confirmado
    return { kind: 'ok', log: res.log! }
  }, [callRegister, refresh])

  const rpcJson = async <T,>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { ok: false as const, code: !error.code ? ('network' as const) : error.message, log: undefined as DoseLog | undefined, _t: null as T | null }
    return { ...(data as RpcResult), _t: null as T | null }
  }

  const correctDose: AppState['correctDose'] = async (log, p) => {
    const r = await rpcJson('correct_dose', {
      p_log_id: log.id, p_expected_version: log.version, p_administered_at: p.administered_at,
      p_dose_text: p.dose_text, p_notes: p.notes, p_status: p.status, p_time_confirmed: p.time_confirmed, p_reason: p.reason
    })
    if (r.ok) await refresh()
    return r as RpcResult & { code?: string } as never
  }
  const voidDose: AppState['voidDose'] = async (log, reason) => {
    const r = await rpcJson('void_dose', { p_log_id: log.id, p_expected_version: log.version, p_reason: reason })
    if (r.ok) await refresh()
    return r as never
  }
  const loadHistory = async (logId: string) => {
    const { data } = await supabase.from('dose_log_history').select('*').eq('dose_log_id', logId).order('changed_at')
    return (data ?? []) as DoseHistoryEntry[]
  }
  const addIncident: AppState['addIncident'] = async (p) => {
    if (!household) return 'Sin hogar'
    const { error } = await supabase.rpc('register_incident', {
      p_household: household.id, p_medication: p.medication_id, p_kind: p.kind, p_description: p.description, p_occurred_at: p.occurred_at
    })
    if (error) return error.message
    await refresh(); return null
  }
  const updateMedication: AppState['updateMedication'] = async (id, patch) => {
    const { error } = await supabase.from('medications').update(patch).eq('id', id)
    if (error) return error.message
    await refresh(); return null
  }
  const verifyMedication: AppState['verifyMedication'] = async (id, verified, note) => {
    const { error } = await supabase.rpc('verify_medication', { p_medication: id, p_verified: verified, p_note: note })
    if (error) return error.message
    await refresh(); return null
  }
  const savePref: AppState['savePref'] = async (p) => {
    if (!household || !session) return 'Sin hogar'
    const { error } = await supabase.from('notification_prefs').upsert(
      { user_id: session.user.id, household_id: household.id, ...p }, { onConflict: 'user_id,medication_id' })
    if (error) return error.message
    await refresh(); return null
  }
  const updateHousehold: AppState['updateHousehold'] = async (patch) => {
    if (!household) return 'Sin hogar'
    const { error } = await supabase.from('households').update(patch).eq('id', household.id)
    if (error) return error.message
    await refresh(); return null
  }
  const updateMyName: AppState['updateMyName'] = async (name) => {
    if (!session) return 'Sin sesión'
    const { error } = await supabase.from('household_members').update({ display_name: name.trim() }).eq('user_id', session.user.id)
    if (error) return error.message
    await refresh(); return null
  }
  const createInvitation: AppState['createInvitation'] = async () => {
    if (!household) return null
    const { data, error } = await supabase.rpc('create_invitation', { p_household: household.id })
    if (error) return null
    return data as string
  }
  const createHousehold: AppState['createHousehold'] = async (family, child, myName) => {
    const { error } = await supabase.rpc('create_household', { p_name: family, p_child_name: child, p_display_name: myName })
    if (error) return error.message
    await refresh(); return null
  }
  const acceptInvitation: AppState['acceptInvitation'] = async (code, myName) => {
    const { error } = await supabase.rpc('accept_invitation', { p_code: code, p_display_name: myName })
    if (error) return error.message === 'invalid_or_expired_invitation' ? 'Código no válido o caducado.' : error.message === 'household_full' ? 'El hogar ya tiene el máximo de personas.' : error.message
    await refresh(); return null
  }
  const enablePush: AppState['enablePush'] = async () => {
    if (!household || !session) return 'Sin hogar'
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Este navegador no admite notificaciones push.'
    if (!VAPID_PUBLIC_KEY) return 'Falta VITE_VAPID_PUBLIC_KEY: las notificaciones push no están configuradas en el servidor.'
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return 'Permiso de notificaciones denegado. Actívalo en los ajustes del navegador para este sitio.'
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) })
    const j = sub.toJSON()
    const { error } = await supabase.from('push_subscriptions').upsert({
      user_id: session.user.id, household_id: household.id, endpoint: sub.endpoint,
      p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '', user_agent: navigator.userAgent.slice(0, 200)
    }, { onConflict: 'endpoint' })
    return error ? error.message : null
  }
  const signOut = async () => { await supabase.auth.signOut() }

  const me = useMemo(() => members.find((m) => m.user_id === session?.user.id) ?? null, [members, session])

  const value: AppState = {
    configured, session, authReady, loading, household, members, me, meds, logs, incidents, prefs, outbox, conflicts,
    online, lastSync, syncError, now, refresh, registerDose, flushOutbox,
    dismissConflict: (opId) => saveConflicts(conflicts.filter((c) => c.op.op_id !== opId)),
    discardOp: (opId) => saveOutbox(outbox.filter((o) => o.op_id !== opId)),
    correctDose, voidDose, loadHistory, addIncident, updateMedication, verifyMedication, savePref,
    updateHousehold, updateMyName, createInvitation, createHousehold, acceptInvitation, enablePush, signOut
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
