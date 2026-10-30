// Lógica pura de horarios e intervalos. Sin efectos secundarios; probada en schedule.test.ts.
// IMPORTANTE: aquí NO se calcula ninguna dosis ni se recomienda nada. Solo se comparan horas
// con los datos introducidos por los padres (pauta de la receta).
import type { DoseLog, Medication } from './types.ts'

export const TZ_DEFAULT = 'Europe/Madrid'
const MIN = 60_000
const HOUR = 60 * MIN

// ───────────── Zona horaria ─────────────
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const p: Record<string, number> = {}
  for (const part of dtf.formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** Hora local de pared (fecha YYYY-MM-DD + HH:MM) en `tz` → instante UTC. */
export function zonedToDate(dateStr: string, timeStr: string, tz = TZ_DEFAULT): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let off = tzOffsetMs(guess, tz)
  let utc = guess - off
  const off2 = tzOffsetMs(utc, tz)
  if (off2 !== off) { utc = guess - off2 }
  return new Date(utc)
}

export function localDateStr(d: Date, tz = TZ_DEFAULT): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
export function localTimeStr(d: Date, tz = TZ_DEFAULT): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
}
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

// ───────────── Tratamiento ─────────────
export function hhmm(t: string | null | undefined): string | null {
  return t ? t.slice(0, 5) : null
}

/** Primera toma prevista del tratamiento (fecha de inicio + hora de inicio, si existe). */
export function treatmentStart(med: Medication, tz = TZ_DEFAULT): Date {
  return zonedToDate(med.start_date, hhmm(med.start_time) ?? '00:00', tz)
}

/** Fin del tratamiento = inicio + N días de calendario. NO se prolonga automáticamente. */
export function treatmentEnd(med: Medication, tz = TZ_DEFAULT): Date | null {
  if (!med.duration_days) return null
  return zonedToDate(addDays(med.start_date, med.duration_days), hhmm(med.start_time) ?? '00:00', tz)
}

export interface TreatmentDays {
  state: 'not_started' | 'running' | 'finished'
  day: number // día actual (1-based) si running
  total: number | null
  remaining: number | null
}
export function treatmentDays(med: Medication, now: Date, tz = TZ_DEFAULT): TreatmentDays {
  const start = treatmentStart(med, tz)
  const end = treatmentEnd(med, tz)
  const total = med.duration_days
  if (now < start) return { state: 'not_started', day: 0, total, remaining: total }
  if (end && now >= end) return { state: 'finished', day: total ?? 0, total, remaining: 0 }
  const today = localDateStr(now, tz)
  const [y1, m1, d1] = med.start_date.split('-').map(Number)
  const [y2, m2, d2] = today.split('-').map(Number)
  const day = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1
  return { state: 'running', day, total, remaining: total ? Math.max(total - day, 0) : null }
}

// ───────────── Horarios previstos ─────────────
export function sortTimes(times: string[]): string[] {
  return [...times].sort()
}

/** Tomas previstas entre `from` y `to` para un medicamento con horario fijo. */
export function slotsBetween(med: Medication, from: Date, to: Date, tz = TZ_DEFAULT): Date[] {
  if (med.schedule_mode !== 'scheduled' || !med.active || med.times.length === 0) return []
  const start = treatmentStart(med, tz)
  const end = treatmentEnd(med, tz)
  const out: Date[] = []
  let day = addDays(localDateStr(from, tz), -1)
  const lastDay = addDays(localDateStr(to, tz), 1)
  for (let guard = 0; day <= lastDay && guard < 400; guard++, day = addDays(day, 1)) {
    for (const t of sortTimes(med.times)) {
      const s = zonedToDate(day, t, tz)
      if (s < start) continue
      if (end && s >= end) continue
      if (s < from || s > to) continue
      out.push(s)
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime())
}

/** Intervalos entre las horas configuradas (cíclico, incluye el salto de medianoche). */
export function configuredGaps(times: string[]): { from: string; to: string; hours: number }[] {
  const ts = sortTimes(times)
  if (ts.length === 0) return []
  if (ts.length === 1) return [{ from: ts[0], to: ts[0], hours: 24 }]
  const mins = ts.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)))
  return ts.map((t, i) => {
    const next = (i + 1) % ts.length
    let diff = mins[next] - mins[i]
    if (diff <= 0) diff += 1440
    return { from: t, to: ts[next], hours: diff / 60 }
  })
}

export interface GapWarning { from: string; to: string; hours: number; expected: number }
/** Intervalos configurados que NO respetan el intervalo indicado en la pauta. */
export function gapWarnings(med: Pick<Medication, 'times' | 'interval_hours'>): GapWarning[] {
  if (!med.interval_hours) return []
  const expected = Number(med.interval_hours)
  return configuredGaps(med.times)
    .filter((g) => Math.abs(g.hours - expected) > 1 / 60)
    .map((g) => ({ ...g, expected }))
}

// ───────────── Estado de cada toma ─────────────
export type SlotState = 'given' | 'skipped' | 'pending_confirm' | 'pending' | 'overdue' | 'upcoming'

export function activeLogs(logs: DoseLog[]): DoseLog[] {
  return logs.filter((l) => l.status !== 'voided')
}

export function logForSlot(logs: DoseLog[], medId: string, slot: Date): DoseLog | undefined {
  return logs.find(
    (l) => l.medication_id === medId && l.status !== 'voided' && l.scheduled_for && new Date(l.scheduled_for).getTime() === slot.getTime()
  )
}

/** pending = hora ya llegó y no hay registro; overdue = pasaron más de `graceMin` minutos. */
export function slotState(log: DoseLog | undefined, slot: Date, now: Date, graceMin = 30): SlotState {
  if (log) return log.status === 'given' ? 'given' : log.status === 'skipped' ? 'skipped' : 'pending_confirm'
  if (now < slot) return 'upcoming'
  return now.getTime() - slot.getTime() > graceMin * MIN ? 'overdue' : 'pending'
}

// ───────────── Intervalos reales ─────────────
export function lastGiven(logs: DoseLog[], medId: string, before?: Date): DoseLog | undefined {
  return logs
    .filter((l) => l.medication_id === medId && l.status === 'given' && l.administered_at && (!before || new Date(l.administered_at) < before))
    .sort((a, b) => new Date(b.administered_at!).getTime() - new Date(a.administered_at!).getTime())[0]
}

export interface IntervalCheck {
  minutes: number | null
  expectedMinutes: number | null
  level: 'ok' | 'early' | 'late' | 'none'
  diffMinutes: number
}
/** Compara el intervalo real con el de la pauta. Tolerancia por defecto: ±15 min. NO corrige nada. */
export function checkInterval(prev: Date | null, current: Date, intervalHours: number | null, toleranceMin = 15): IntervalCheck {
  if (!prev || !intervalHours) return { minutes: null, expectedMinutes: null, level: 'none', diffMinutes: 0 }
  const minutes = Math.round((current.getTime() - prev.getTime()) / MIN)
  const expectedMinutes = Math.round(intervalHours * 60)
  const diff = minutes - expectedMinutes
  const level = Math.abs(diff) <= toleranceMin ? 'ok' : diff < 0 ? 'early' : 'late'
  return { minutes, expectedMinutes, level, diffMinutes: diff }
}

/** Desviación entre hora prevista y hora efectiva (positivo = tarde). */
export function deviationMinutes(scheduled: Date, actual: Date): number {
  return Math.round((actual.getTime() - scheduled.getTime()) / MIN)
}

export function fmtDuration(totalMin: number): string {
  const abs = Math.abs(Math.round(totalMin))
  const h = Math.floor(abs / 60)
  const m = abs % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** Hora a partir de la cual se cumple el intervalo indicado en la receta desde la última toma (solo informativo). */
export function nextByInterval(last: Date | null, intervalHours: number | null): Date | null {
  if (!last || !intervalHours) return null
  return new Date(last.getTime() + intervalHours * HOUR)
}
