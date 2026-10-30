import { useMemo, useState } from 'react'
import { useApp, type RegisterOutcome } from './store'
import type { DoseLog, Medication } from './types'
import {
  checkInterval, deviationMinutes, fmtDuration, lastGiven, localDateStr, localTimeStr, logForSlot, slotsBetween, zonedToDate
} from './schedule'
import { Sheet, fmtDateTime, medTitle } from './ui'

function toLocalInput(d: Date, tz: string) { return `${localDateStr(d, tz)}T${localTimeStr(d, tz)}` }
function fromLocalInput(v: string, tz: string): Date { const [d, t] = v.split('T'); return zonedToDate(d, t, tz) }

export function RegisterSheet({ med: initialMed, slot, onClose, onResult }: {
  med: Medication; slot?: Date | null; onClose: () => void; onResult: (msg: string) => void
}) {
  const { meds, logs, members, me, household, now, registerDose } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [medId, setMedId] = useState(initialMed.id)
  const med = meds.find((m) => m.id === medId) ?? initialMed
  const [slotMs, setSlotMs] = useState<number | null>(slot ? slot.getTime() : null)
  const [status, setStatus] = useState<'given' | 'skipped'>('given')
  const [when, setWhen] = useState(toLocalInput(now, tz))
  const [givenBy, setGivenBy] = useState(me?.user_id ?? '')
  const [notes, setNotes] = useState('')
  const [step, setStep] = useState<'form' | 'confirm'>('form')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<RegisterOutcome | null>(null)

  // Horarios previstos sin registrar (últimas 24 h y próximas 6 h)
  const slotOptions = useMemo(() => {
    const all = slotsBetween(med, new Date(now.getTime() - 24 * 3_600_000), new Date(now.getTime() + 6 * 3_600_000), tz)
    return all.filter((s) => !logForSlot(logs, med.id, s) || s.getTime() === slotMs)
  }, [med, logs, now, tz, slotMs])

  const chosenSlot = slotMs ? new Date(slotMs) : null
  const slotLog: DoseLog | undefined = chosenSlot ? logForSlot(logs, med.id, chosenSlot) : undefined
  const actual = fromLocalInput(when, tz)
  const prev = lastGiven(logs, med.id, actual)
  const prevAt = prev?.administered_at ? new Date(prev.administered_at) : null
  const ic = checkInterval(prevAt, actual, med.interval_hours)
  const dev = chosenSlot ? deviationMinutes(chosenSlot, actual) : 0
  const person = members.find((m) => m.user_id === givenBy)

  const warnings: string[] = []
  if (!med.verified) warnings.push('La pauta y el horario de este medicamento aún no están verificados con pediatría/farmacia.')
  if (status === 'given' && ic.level === 'early')
    warnings.push(`Han pasado ${fmtDuration(ic.minutes!)} desde la toma anterior (${fmtDateTime(prevAt, tz)}); la pauta indica ${fmtDuration(ic.expectedMinutes!)}. Faltan ${fmtDuration(-ic.diffMinutes)}.`)
  if (status === 'given' && ic.level === 'late')
    warnings.push(`Han pasado ${fmtDuration(ic.minutes!)} desde la toma anterior; la pauta indica ${fmtDuration(ic.expectedMinutes!)}. No se compensa ni se duplica la siguiente dosis.`)
  if (chosenSlot && Math.abs(dev) > 30)
    warnings.push(`La hora real se aleja ${fmtDuration(dev)} ${dev > 0 ? 'después' : 'antes'} del horario previsto (${localTimeStr(chosenSlot, tz)}).`)
  if (actual.getTime() > now.getTime() + 5 * 60_000) warnings.push('La hora indicada está en el futuro.')

  const canContinue = !slotLog && !(status === 'skipped' && !notes.trim()) && actual.getTime() <= now.getTime() + 5 * 60_000 && !!givenBy

  async function send(force: boolean) {
    setBusy(true)
    const r = await registerDose({
      medication: med, scheduled_for: chosenSlot ? chosenSlot.toISOString() : null, administered_at: actual.toISOString(),
      dose_text: med.dose_text, notes: notes.trim() || null, status, time_confirmed: true,
      given_by: givenBy || null, given_by_name: person?.display_name ?? '', force
    })
    setBusy(false)
    if (r.kind === 'ok') { onResult(status === 'given' ? 'Toma registrada y sincronizada ✓' : 'Omisión registrada y sincronizada ✓'); onClose() }
    else if (r.kind === 'queued') { onResult('Sin conexión: guardada SOLO en este teléfono. No consta como administrada hasta sincronizar.'); onClose() }
    else setOutcome(r)
  }

  if (outcome) {
    const who = outcome.kind === 'conflict' && outcome.log
    return (
      <Sheet title="No se ha registrado" onClose={onClose}>
        {outcome.kind === 'conflict' && outcome.code === 'slot_already_recorded' && (
          <div className="alert bad"><strong>Esta toma ya estaba registrada</strong>
            {who && <>{outcome.log!.administered_by_name} la registró {fmtDateTime(outcome.log!.administered_at, tz)}. No se ha duplicado.</>}
          </div>)}
        {outcome.kind === 'conflict' && outcome.code === 'possible_duplicate' && (
          <>
            <div className="alert warn"><strong>Posible duplicado</strong>
              Ya hay una toma de {med.name} registrada {who ? `por ${outcome.log!.administered_by_name} ${fmtDateTime(outcome.log!.administered_at, tz)}` : 'hace pocos minutos'}. ¿Es otra toma distinta?
            </div>
            <button className="btn gold" disabled={busy} onClick={() => { setOutcome(null); void send(true) }}>Sí, registrar igualmente</button>
          </>)}
        {outcome.kind === 'conflict' && outcome.code === 'future_time' && <div className="alert bad">La hora está en el futuro.</div>}
        {outcome.kind === 'conflict' && !['slot_already_recorded', 'possible_duplicate', 'future_time'].includes(outcome.code) && <div className="alert bad">No se pudo registrar ({outcome.code}).</div>}
        {outcome.kind === 'error' && <div className="alert bad">Error del servidor: {outcome.message}</div>}
        <button className="btn ghost" onClick={onClose}>Cerrar</button>
      </Sheet>
    )
  }

  if (step === 'confirm') {
    return (
      <Sheet title="Confirmar registro" onClose={onClose}>
        <div className="card">
          <div className="med-name">{medTitle(med)}</div>
          <div className="dose">{med.dose_text}</div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Estado</dt><dd>{status === 'given' ? 'Administrada' : 'NO administrada (omitida)'}</dd>
            <dt>Hora real</dt><dd>{fmtDateTime(actual, tz)}</dd>
            {chosenSlot && <><dt>Horario previsto</dt><dd>{localTimeStr(chosenSlot, tz)}</dd></>}
            <dt>Persona</dt><dd>{person?.display_name}</dd>
            {notes.trim() && <><dt>Observaciones</dt><dd>{notes.trim()}</dd></>}
          </dl>
        </div>
        {warnings.map((w, i) => <div key={i} className="alert warn">{w}</div>)}
        <div className="muted">Solo constará como registrada cuando el servidor lo confirme.</div>
        <button className="btn gold" disabled={busy} onClick={() => void send(false)}>
          {busy ? <span className="spinner" /> : status === 'given' ? 'Confirmar: la he administrado' : 'Confirmar: no administrada'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setStep('form')}>Volver y editar</button>
      </Sheet>
    )
  }

  return (
    <Sheet title="Registrar toma" onClose={onClose}>
      <label className="field">Medicamento
        <select className="input" value={medId} onChange={(e) => { setMedId(e.target.value); setSlotMs(null) }}>
          {meds.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{medTitle(m)}</option>)}
        </select>
      </label>
      <div className="card">
        <div className="muted">Dosis que figura en la pauta</div>
        <div className="dose">{med.dose_text}</div>
        <div className="muted">{med.frequency_text}{med.verified ? '' : ' · pauta sin verificar'}</div>
      </div>
      <div className="seg">
        <button className={status === 'given' ? 'on' : ''} onClick={() => setStatus('given')}>Administrada</button>
        <button className={status === 'skipped' ? 'on' : ''} onClick={() => setStatus('skipped')}>No administrada</button>
      </div>
      {med.schedule_mode === 'scheduled' && (
        <label className="field">Horario previsto
          <select className="input" value={slotMs ?? ''} onChange={(e) => setSlotMs(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Sin horario previsto</option>
            {slotOptions.map((s) => <option key={s.getTime()} value={s.getTime()}>{fmtDateTime(s, tz)}</option>)}
          </select>
        </label>
      )}
      {slotLog && <div className="alert bad"><strong>Esta toma ya está registrada</strong>{slotLog.administered_by_name} · {fmtDateTime(slotLog.administered_at, tz)}</div>}
      <label className="field">Hora real de administración
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </label>
      <label className="field">Persona que la administra
        <select className="input" value={givenBy} onChange={(e) => setGivenBy(e.target.value)}>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
        </select>
      </label>
      <label className="field">Observaciones {status === 'skipped' ? '(obligatorio: motivo)' : '(opcional)'}
        <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {warnings.map((w, i) => <div key={i} className="alert warn">{w}</div>)}
      <button className="btn" disabled={!canContinue} onClick={() => setStep('confirm')}>Continuar</button>
    </Sheet>
  )
}
