// @vitest-environment jsdom
// Prueba de humo de la interfaz con un cliente Supabase SIMULADO (no es la base de datos real).
// Comprueba la lógica de pantalla: avisos, flujo de confirmación, conflictos y cola sin conexión.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const state: { logs: any[]; rpc: (name: string, args: any) => Promise<any> } = { logs: [], rpc: async () => ({ data: null, error: null }) }
  const calls: { name: string; args: any }[] = []
  const users = [{ household_id: 'h1', user_id: 'u1', display_name: 'Carlos' }, { household_id: 'h1', user_id: 'u2', display_name: 'Mireia' }]
  const med = (o: any) => ({ household_id: 'h1', strength: null, source_note: null, notes: null, verified: false, verified_by: null, verified_at: null, verified_note: null, active: true, ...o })
  const meds = [
    med({ id: 'aug', name: 'Augmentine suspensión oral', strength: '100 mg/ml + 12,5 mg/ml', dose_text: '4 ml', frequency_text: 'Cada 8 horas', interval_hours: 8, duration_days: 10, schedule_mode: 'scheduled', times: ['06:00', '14:00', '22:00'], start_date: '2026-10-29', start_time: '22:00:00', sort_order: 1 }),
    med({ id: 'dal', name: 'Dalsy', strength: '40 mg/ml', dose_text: '4 ml', frequency_text: 'Cada 8 horas, según receta', interval_hours: 8, duration_days: 3, schedule_mode: 'manual', times: [], start_date: '2026-10-29', start_time: null, sort_order: 3 }),
    med({ id: 'api', name: 'Apiretal', strength: '100 mg/ml', dose_text: '2,8 ml', frequency_text: 'Cada 6 horas, según receta', interval_hours: 6, duration_days: 3, schedule_mode: 'manual', times: [], start_date: '2026-10-29', start_time: null, sort_order: 4 })
  ]
  const logBase = { household_id: 'h1', scheduled_for: null, notes: null, recorded_by: null, version: 1, created_at: '2026-10-29T14:31:00Z', updated_at: '2026-10-29T14:31:00Z', approx_date: null, time_confirmed: true }
  const initialLogs = () => [
    { ...logBase, id: 'l1', client_op_id: 'o1', medication_id: 'dal', administered_at: '2026-10-29T14:30:00Z', status: 'given', dose_text: '4 ml', administered_by: null, administered_by_name: 'Dato inicial familiar' },
    { ...logBase, id: 'l2', client_op_id: 'o2', medication_id: 'api', administered_at: null, approx_date: '2026-10-29', status: 'pending_confirm', time_confirmed: false, dose_text: '2,8 ml', administered_by: null, administered_by_name: 'Dato inicial familiar' }
  ]
  const tables: Record<string, () => any[]> = {
    household_members: () => users,
    households: () => [{ id: 'h1', name: 'Familia', child_name: 'Aris', child_weight_kg: 19, timezone: 'Europe/Madrid', max_members: 2 }],
    medications: () => meds,
    dose_logs: () => state.logs,
    incidents: () => [],
    notification_prefs: () => []
  }
  const builder = (table: string) => {
    let single = false
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, neq: () => b,
      single: () => { single = true; return b }, update: () => b, upsert: () => b, delete: () => b,
      then: (res: any, rej: any) => Promise.resolve({ data: single ? (tables[table]?.() ?? [])[0] : tables[table]?.() ?? [], error: null }).then(res, rej)
    }
    return b
  }
  const fake = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: any) => { calls.push({ name, args }); return state.rpc(name, args) },
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: async () => undefined,
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1', email: 'carlos@test' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => undefined
    }
  }
  return { state, calls, fake, initialLogs }
})

vi.mock('./supabase', () => ({ supabase: h.fake, configured: true, VAPID_PUBLIC_KEY: '' }))

import App from './App'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-29T19:10:00Z')) // 20:10 hora de Madrid
  h.state.logs = h.initialLogs()
  h.calls.length = 0
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function home() { render(<App />); await screen.findByText('Aris') }

describe('Pantalla principal', () => {
  it('muestra niña, fecha/hora, medicamentos, avisos y estado de cada toma', async () => {
    await home()
    expect(screen.getByText(/jueves.*29 de octubre.*20:10/i)).toBeTruthy()
    expect(screen.getAllByText(/Augmentine/).length).toBeGreaterThan(0)
    expect(screen.getByText('Pauta sin verificar')).toBeTruthy()
    expect(screen.getByText('Hora por confirmar')).toBeTruthy()
    expect(screen.getByText('22:00')).toBeTruthy()           // próxima toma prevista
    expect(screen.getAllByText('Prevista').length).toBe(2)   // 22:00 de hoy y 06:00 de mañana (ventana de 14 h)
    expect(screen.getByText('06:00')).toBeTruthy()
    expect(screen.getAllByText(/Registrar toma/).length).toBe(3)
    expect(screen.getAllByText(/Dato inicial familiar/).length).toBeGreaterThan(0)
  })
  it('Dalsy y Apiretal tienen tarjetas separadas y sin horario automático', async () => {
    await home()
    expect(screen.getAllByText(/registro manual/).length).toBe(2)
  })
})

describe('Registrar toma', () => {
  async function openAndFill() {
    await home()
    fireEvent.click(screen.getAllByText('Registrar', { selector: 'button' })[0]) // toma de las 22:00
    await screen.findByText('Dosis que figura en la pauta')
  }
  it('pide confirmación antes de registrar y envía los datos correctos', async () => {
    h.state.rpc = async (name) => {
      if (name === 'register_dose') { h.state.logs.unshift({ ...h.initialLogs()[0], id: 'new', status: 'given', medication_id: 'aug', scheduled_for: '2026-10-29T21:00:00Z', administered_at: '2026-10-29T21:02:00Z', administered_by_name: 'Carlos', dose_text: '4 ml' }); return { data: { ok: true, log: h.state.logs[0] }, error: null } }
      return { data: null, error: null }
    }
    await openAndFill()
    fireEvent.click(screen.getByText('Continuar'))
    await screen.findByText('Confirmar registro')
    expect(h.calls.length).toBe(0)                            // nada enviado todavía
    fireEvent.click(screen.getByText('Confirmar: la he administrado'))
    await waitFor(() => expect(h.calls.some((c) => c.name === 'register_dose')).toBe(true))
    const c = h.calls.find((x) => x.name === 'register_dose')!
    expect(c.args.p_medication_id).toBe('aug')
    expect(c.args.p_scheduled_for).toBe('2026-10-29T21:00:00.000Z')
    expect(c.args.p_given_by).toBe('u1')
    expect(c.args.p_dose_text).toBe('4 ml')
    expect(typeof c.args.p_client_op_id).toBe('string')
    await screen.findByText(/Toma registrada y sincronizada/)
  })
  it('si el servidor dice que la toma ya existe, avisa y no duplica', async () => {
    h.state.rpc = async () => ({ data: { ok: false, code: 'slot_already_recorded', log: { administered_by_name: 'Mireia', administered_at: '2026-10-29T21:00:00Z' } }, error: null })
    await openAndFill()
    fireEvent.click(screen.getByText('Continuar'))
    fireEvent.click(await screen.findByText('Confirmar: la he administrado'))
    await screen.findByText('Esta toma ya estaba registrada')
    expect(screen.getByText(/Mireia la registró/)).toBeTruthy()
  })
  it('sin conexión: se guarda en cola y NO se muestra como administrada', async () => {
    h.state.rpc = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } })
    await openAndFill()
    fireEvent.click(screen.getByText('Continuar'))
    fireEvent.click(await screen.findByText('Confirmar: la he administrado'))
    await screen.findByText(/guardada SOLO en este teléfono/)
    expect(JSON.parse(localStorage.getItem('aris_outbox_v1')!).length).toBe(1)
    await screen.findByText(/1 registro\(s\) sin sincronizar/)
    expect(screen.queryAllByText('Administrada').length).toBe(1)   // solo el dato inicial de Dalsy; la toma en cola NO figura como administrada
  })
  it('avisa de intervalo corto frente a la toma anterior (Dalsy a 5 h de la última)', async () => {
    await home()
    fireEvent.click(screen.getAllByText('Registrar toma')[1])   // Dalsy
    await screen.findByText('Dosis que figura en la pauta')
    expect(screen.getByText(/Han pasado 4 h 40 min desde la toma anterior/)).toBeTruthy()
    expect(screen.getByText(/Faltan 3 h 20 min/)).toBeTruthy()
  })
})
