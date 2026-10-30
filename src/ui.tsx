import { useEffect, useState, type ReactNode } from 'react'
import type { DoseLog, Medication } from './types'
import { localDateStr, localTimeStr } from './schedule'

export const DISCLAIMER = 'Herramienta de registro. No es un sistema de prescripción ni sustituye al pediatra.'

export function fmtDateTime(iso: string | Date | null | undefined, tz: string): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const today = localDateStr(new Date(), tz)
  const ds = localDateStr(d, tz)
  const yesterday = localDateStr(new Date(Date.now() - 86_400_000), tz)
  const time = localTimeStr(d, tz)
  if (ds === today) return `hoy ${time}`
  if (ds === yesterday) return `ayer ${time}`
  const [y, m, dd] = ds.split('-')
  return `${dd}/${m}/${y.slice(2)} ${time}`
}
export function fmtLongNow(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  return (
    <div className="sheet-bg" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>{title}</h2>
          <button className="x" style={{ color: 'var(--navy)' }} onClick={onClose} aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3800); return () => clearTimeout(t) }, [msg])
  return { show: setMsg, node: msg ? <div className="toast" role="status">{msg}</div> : null }
}

export const STATUS_LABEL: Record<string, string> = {
  given: 'Administrada', skipped: 'Omitida', pending_confirm: 'Pendiente de confirmar', pending: 'Pendiente',
  overdue: 'Retrasada', upcoming: 'Prevista', voided: 'Anulada'
}
export function StatusChip({ state }: { state: string }) {
  const cls = state === 'pending_confirm' ? 'confirm' : state === 'voided' ? 'skipped' : state
  return <span className={`chip ${cls}`}>{STATUS_LABEL[state] ?? state}</span>
}

export function medTitle(m: Medication): string {
  return m.strength ? `${m.name} · ${m.strength}` : m.name
}

export function logTimeLabel(l: DoseLog, tz: string): string {
  if (l.administered_at) return fmtDateTime(l.administered_at, tz) + (l.time_confirmed ? '' : ' (hora sin confirmar)')
  if (l.approx_date) { const [y, m, d] = l.approx_date.split('-'); return `${d}/${m}/${y.slice(2)} · hora sin confirmar` }
  return '—'
}
