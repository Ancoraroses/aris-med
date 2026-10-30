import { useMemo, useState } from 'react'
import { useApp } from './store'
import type { Medication } from './types'
import {
  activeLogs, fmtDuration, gapWarnings, lastGiven, localTimeStr, logForSlot, nextByInterval, slotsBetween, slotState, treatmentDays
} from './schedule'
import { RegisterSheet } from './RegisterSheet'
import { StatusChip, fmtDateTime, fmtLongNow, logTimeLabel, medTitle, useToast } from './ui'

export function Home({ goto }: { goto: (tab: 'hist' | 'meds' | 'settings') => void }) {
  const { household, meds, logs, now, online, lastSync, syncError, outbox, conflicts, dismissConflict, flushOutbox, discardOp, prefs } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [reg, setReg] = useState<{ med: Medication; slot: Date | null } | null>(null)
  const toast = useToast()
  const active = meds.filter((m) => m.active)

  // Estado de cada toma prevista (últimas 12 h y próximas 14 h)
  const slots = useMemo(() => {
    const out: { med: Medication; slot: Date; state: ReturnType<typeof slotState>; by?: string; at?: string | null }[] = []
    for (const med of active) {
      for (const s of slotsBetween(med, new Date(now.getTime() - 12 * 3_600_000), new Date(now.getTime() + 14 * 3_600_000), tz)) {
        const log = logForSlot(logs, med.id, s)
        out.push({ med, slot: s, state: slotState(log, s, now), by: log?.administered_by_name, at: log?.administered_at })
      }
    }
    return out.sort((a, b) => a.slot.getTime() - b.slot.getTime())
  }, [active, logs, now, tz])

  const pendingConfirm = activeLogs(logs).filter((l) => l.status === 'pending_confirm')
  const unverified = active.filter((m) => !m.verified)
  const overdue = slots.filter((s) => s.state === 'overdue' || s.state === 'pending')
  const gaps = active.filter((m) => m.schedule_mode === 'scheduled').flatMap((m) => gapWarnings(m).map((g) => ({ m, g })))
  const ended = active.filter((m) => treatmentDays(m, now, tz).state === 'finished')
  const lastActivity = activeLogs(logs).slice(0, 5)
  const medName = (id: string) => meds.find((m) => m.id === id)?.name ?? '—'
  const reminderOn = prefs.some((p) => p.enabled)

  return (
    <>
      <header className="hero">
        <div className="kicker">Medicación de</div>
        <h1>{household?.child_name ?? 'Aris'}</h1>
        <div className="clock">{fmtLongNow(now, tz)}</div>
        <div className="sync">
          <span className={`dot ${syncError ? 'err' : online ? '' : 'off'}`} />
          {syncError ? 'Error de sincronización' : online ? `Sincronizado${lastSync ? ' · ' + localTimeStr(lastSync, tz) : ''}` : 'Sin conexión'}
        </div>
      </header>

      <div className="page">
        <div className="section-title">Avisos importantes</div>
        {syncError && <div className="alert bad"><strong>No se pudo sincronizar</strong>{syncError}</div>}
        {outbox.length > 0 && (
          <div className="alert bad">
            <strong>{outbox.length} registro(s) sin sincronizar</strong>
            Guardados solo en este teléfono. NO constan como administrados para el otro progenitor hasta que se envíen.
            {outbox.map((o) => (
              <div key={o.op_id} className="muted" style={{ marginTop: 4 }}>
                {o.medication_name} · {fmtDateTime(o.administered_at, tz)} · {o.given_by_name}{' '}
                <button className="btn ghost small" onClick={() => discardOp(o.op_id)}>Descartar</button>
              </div>
            ))}
            <button className="btn small" disabled={!online} onClick={() => void flushOutbox()}>Reintentar envío</button>
          </div>
        )}
        {conflicts.map((c) => (
          <div key={c.op.op_id} className="alert warn">
            <strong>No se pudo sincronizar: {c.op.medication_name} ({fmtDateTime(c.op.administered_at, tz)})</strong>
            {c.code === 'slot_already_recorded' ? 'Esa toma ya la había registrado otra persona; no se duplicó.' : c.code === 'possible_duplicate' ? 'Había otra toma muy cercana; revisa el historial.' : `Motivo: ${c.code}`}
            <button className="btn ghost small" onClick={() => dismissConflict(c.op.op_id)}>Entendido</button>
          </div>
        ))}
        {pendingConfirm.length > 0 && (
          <div className="alert warn"><strong>Hora por confirmar</strong>
            {pendingConfirm.map((l) => <div key={l.id}>{medName(l.medication_id)}: administrada el {logTimeLabel(l, tz)}.</div>)}
            <button className="btn small gold" onClick={() => goto('hist')}>Corregir en historial</button>
          </div>
        )}
        {overdue.length > 0 && (
          <div className="alert bad"><strong>Tomas previstas sin registrar</strong>
            {overdue.map((s) => <div key={s.med.id + s.slot.getTime()}>{s.med.name} · {localTimeStr(s.slot, tz)}</div>)}
            Regístralas como administradas u omitidas. La app no las da por hechas ni las recupera sola.
          </div>
        )}
        {unverified.length > 0 && (
          <div className="alert warn"><strong>Pauta sin verificar</strong>
            Los datos proceden de la receta del 29/10/2026 y el horario 22:00/06:00/14:00 es una propuesta. Confírmalos con pediatría o farmacia. Los recordatorios no se activan hasta verificarlos.
            <button className="btn small gold" onClick={() => goto('meds')}>Revisar pautas</button>
          </div>
        )}
        {gaps.map(({ m, g }) => (
          <div key={m.id + g.from} className="alert warn">
            <strong>{m.name}: intervalo distinto al indicado</strong>
            De {g.from} a {g.to} hay {fmtDuration(g.hours * 60)} y la pauta indica {fmtDuration(g.expected * 60)}.
          </div>
        ))}
        {ended.map((m) => <div key={m.id} className="alert info"><strong>{m.name}: duración indicada cumplida</strong>No se prolonga automáticamente. Consulta con el pediatra antes de continuar.</div>)}
        {!reminderOn && unverified.length === 0 && <div className="alert info">Recordatorios sin activar. Puedes hacerlo en Ajustes.</div>}
        {!syncError && outbox.length === 0 && conflicts.length === 0 && pendingConfirm.length === 0 && overdue.length === 0 && unverified.length === 0 && gaps.length === 0 && ended.length === 0 &&
          <div className="muted" style={{ marginLeft: 4 }}>Sin avisos.</div>}

        <div className="section-title">Próximas tomas previstas</div>
        <div className="card">
          {slots.length === 0 && <div className="muted">No hay tomas con horario fijo en las próximas horas.</div>}
          {slots.map((s) => (
            <div className="slot" key={s.med.id + s.slot.getTime()}>
              <div className="t">{localTimeStr(s.slot, tz)}</div>
              <div>
                <div className="m">{s.med.name} · {s.med.dose_text}</div>
                <div className="muted"><StatusChip state={s.state} /> {s.by ? `· ${s.by}${s.at ? ' ' + localTimeStr(new Date(s.at), tz) : ''}` : ''}</div>
              </div>
              {(s.state === 'upcoming' || s.state === 'pending' || s.state === 'overdue') &&
                <button className="btn small gold" onClick={() => setReg({ med: s.med, slot: s.slot })}>Registrar</button>}
            </div>
          ))}
        </div>

        <div className="section-title">Medicamentos</div>
        {active.map((m) => {
          const td = treatmentDays(m, now, tz)
          const last = lastGiven(logs, m.id)
          const lastAt = last?.administered_at ? new Date(last.administered_at) : null
          const byInterval = m.schedule_mode === 'manual' ? nextByInterval(lastAt, m.interval_hours) : null
          const pc = activeLogs(logs).find((l) => l.medication_id === m.id && l.status === 'pending_confirm')
          return (
            <div className="card" key={m.id}>
              <div className="row between">
                <div className="med-name">{medTitle(m)}</div>
                {!m.verified && <span className="chip warn">sin verificar</span>}
              </div>
              <div className="dose">{m.dose_text}</div>
              <div className="muted">{m.frequency_text}{m.schedule_mode === 'scheduled' ? ` · ${[...m.times].sort().join(' / ')}` : ' · registro manual'}</div>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Tratamiento</dt>
                <dd>{td.state === 'not_started' ? `Empieza ${m.start_date.split('-').reverse().join('/')}${m.start_time ? ' ' + m.start_time.slice(0, 5) : ''}` : td.state === 'finished' ? 'Duración cumplida' : `Día ${td.day}${td.total ? ' de ' + td.total : ''}`}</dd>
                <dt>Última toma</dt>
                <dd>{last ? `${fmtDateTime(last.administered_at, tz)} · ${last.administered_by_name}` : pc ? 'hora por confirmar' : 'sin registros'}</dd>
                {lastAt && <><dt>Hace</dt><dd>{fmtDuration((now.getTime() - lastAt.getTime()) / 60000)}</dd></>}
                {byInterval && <><dt>Intervalo de la receta</dt><dd>{m.interval_hours} h → {localTimeStr(byInterval, tz)}</dd></>}
              </dl>
              {pc && <div className="alert warn" style={{ marginTop: 8 }}>Administrada {logTimeLabel(pc, tz)}</div>}
              <button className="btn" style={{ marginTop: 12 }} onClick={() => setReg({ med: m, slot: null })}>Registrar toma</button>
            </div>
          )
        })}

        <div className="section-title">Última actividad</div>
        <div className="card">
          {lastActivity.length === 0 && <div className="muted">Aún no hay registros.</div>}
          {lastActivity.map((l) => (
            <div className="hist-item" key={l.id} onClick={() => goto('hist')}>
              <div className="row between"><b>{medName(l.medication_id)}</b><StatusChip state={l.status} /></div>
              <div className="muted">{logTimeLabel(l, tz)} · {l.administered_by_name}</div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ textAlign: 'center' }}>Herramienta de registro. No sustituye al pediatra.</p>
      </div>
      {reg && <RegisterSheet med={reg.med} slot={reg.slot} onClose={() => setReg(null)} onResult={toast.show} />}
      {toast.node}
    </>
  )
}
