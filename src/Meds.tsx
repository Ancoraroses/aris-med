import { useState } from 'react'
import { useApp } from './store'
import type { Medication } from './types'
import { configuredGaps, fmtDuration, gapWarnings, treatmentDays, treatmentEnd, localDateStr, localTimeStr } from './schedule'
import { Sheet, fmtDateTime, medTitle, useToast } from './ui'

export function Meds() {
  const { meds, household, now } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [edit, setEdit] = useState<Medication | null>(null)
  const toast = useToast()

  return (
    <div className="page" style={{ paddingTop: 20 }}>
      <h2 style={{ color: 'var(--navy)' }}>Pautas y horarios</h2>
      <div className="alert info">
        Datos de la receta del 29/10/2026, introducidos por la familia. <b>Verifícalos con pediatría o farmacia.</b>
        La app no calcula ni cambia dosis (tampoco según el peso). Peso indicado por la familia: {household?.child_weight_kg ?? '—'} kg (solo informativo).
      </div>
      {meds.map((m) => {
        const td = treatmentDays(m, now, tz)
        const end = treatmentEnd(m, tz)
        const gw = gapWarnings(m)
        return (
          <div className="card" key={m.id} style={{ opacity: m.active ? 1 : 0.6 }}>
            <div className="row between"><div className="med-name">{medTitle(m)}</div>
              <span className={`chip ${m.verified ? 'given' : 'warn'}`}>{m.verified ? 'verificada' : 'sin verificar'}</span></div>
            <dl className="kv" style={{ marginTop: 6 }}>
              <dt>Dosis</dt><dd>{m.dose_text}</dd>
              <dt>Frecuencia</dt><dd>{m.frequency_text}</dd>
              <dt>Horario</dt><dd>{m.schedule_mode === 'scheduled' ? [...m.times].sort().join(' · ') : 'registro manual'}</dd>
              <dt>Inicio</dt><dd>{m.start_date.split('-').reverse().join('/')}{m.start_time ? ' ' + m.start_time.slice(0, 5) : ''}</dd>
              <dt>Duración</dt><dd>{m.duration_days ? `${m.duration_days} días${end ? ` (hasta ${fmtDateTime(end, tz)})` : ''}` : '—'}</dd>
              <dt>Hoy</dt><dd>{td.state === 'running' ? `día ${td.day} de ${td.total ?? '?'}` : td.state === 'finished' ? 'cumplida' : 'no iniciado'}</dd>
            </dl>
            {gw.map((g) => <div className="alert warn" key={g.from} style={{ marginTop: 8 }}>{g.from} → {g.to}: {fmtDuration(g.hours * 60)} (pauta: {fmtDuration(g.expected * 60)})</div>)}
            {m.source_note && <div className="muted" style={{ marginTop: 6 }}>{m.source_note}</div>}
            {m.notes && <div className="muted">{m.notes}</div>}
            <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setEdit(m)}>Editar / verificar</button>
          </div>
        )
      })}
      {edit && <EditSheet med={meds.find((m) => m.id === edit.id) ?? edit} onClose={() => setEdit(null)} onMsg={toast.show} />}
      {toast.node}
    </div>
  )
}

function EditSheet({ med, onClose, onMsg }: { med: Medication; onClose: () => void; onMsg: (m: string) => void }) {
  const { updateMedication, verifyMedication, household, now } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [f, setF] = useState({
    name: med.name, strength: med.strength ?? '', dose_text: med.dose_text, frequency_text: med.frequency_text,
    interval_hours: med.interval_hours?.toString() ?? '', duration_days: med.duration_days?.toString() ?? '',
    schedule_mode: med.schedule_mode, start_date: med.start_date, start_time: med.start_time?.slice(0, 5) ?? '', notes: med.notes ?? ''
  })
  const [times, setTimes] = useState<string[]>([...med.times].sort())
  const [vNote, setVNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }))

  const interval = f.interval_hours ? Number(f.interval_hours.replace(',', '.')) : null
  const gaps = configuredGaps(times)
  const warn = gapWarnings({ times, interval_hours: interval })

  async function save() {
    setBusy(true); setErr(null)
    const e = await updateMedication(med.id, {
      name: f.name.trim(), strength: f.strength.trim() || null, dose_text: f.dose_text.trim(), frequency_text: f.frequency_text.trim(),
      interval_hours: interval, duration_days: f.duration_days ? Number(f.duration_days) : null,
      schedule_mode: f.schedule_mode as Medication['schedule_mode'],
      times: f.schedule_mode === 'scheduled' ? [...new Set(times.filter(Boolean))].sort() : [],
      start_date: f.start_date, start_time: f.start_time || null, notes: f.notes.trim() || null
    })
    setBusy(false)
    if (e) setErr(e); else { onMsg('Guardado. La pauta queda «sin verificar» hasta que la confirmes de nuevo.'); onClose() }
  }
  async function verify(v: boolean) {
    setBusy(true)
    const e = await verifyMedication(med.id, v, vNote)
    setBusy(false)
    if (e) setErr(e); else { onMsg(v ? 'Marcada como verificada con el profesional sanitario.' : 'Verificación retirada.'); onClose() }
  }
  async function toggleActive() {
    const e = await updateMedication(med.id, { active: !med.active })
    if (e) setErr(e); else onClose()
  }

  return (
    <Sheet title={`Editar ${med.name}`} onClose={onClose}>
      <label className="field">Nombre<input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label className="field">Concentración<input className="input" value={f.strength} onChange={(e) => set('strength', e.target.value)} /></label>
      <label className="field">Dosis que figura en la pauta<input className="input" value={f.dose_text} onChange={(e) => set('dose_text', e.target.value)} /></label>
      <label className="field">Frecuencia (texto de la receta)<input className="input" value={f.frequency_text} onChange={(e) => set('frequency_text', e.target.value)} /></label>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>Intervalo (horas)<input className="input" inputMode="decimal" value={f.interval_hours} onChange={(e) => set('interval_hours', e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Duración (días)<input className="input" inputMode="numeric" value={f.duration_days} onChange={(e) => set('duration_days', e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="field" style={{ flex: 1 }}>Fecha de inicio<input className="input" type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
        <label className="field" style={{ flex: 1 }}>Hora 1.ª toma<input className="input" type="time" value={f.start_time} onChange={(e) => set('start_time', e.target.value)} /></label>
      </div>
      <div className="muted">La duración cuenta desde el inicio y no se prolonga automáticamente. Hoy: {localDateStr(now, tz).split('-').reverse().join('/')} {localTimeStr(now, tz)}.</div>
      <div className="seg">
        <button className={f.schedule_mode === 'scheduled' ? 'on' : ''} onClick={() => set('schedule_mode', 'scheduled')}>Horario fijo</button>
        <button className={f.schedule_mode === 'manual' ? 'on' : ''} onClick={() => set('schedule_mode', 'manual')}>Registro manual</button>
      </div>
      {f.schedule_mode === 'scheduled' && (
        <div className="stack">
          <div className="muted">Horas de toma (propuesta pendiente de confirmar)</div>
          {times.map((t, i) => (
            <div className="time-row" key={i}>
              <input className="input" type="time" value={t} onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))} />
              <button className="x" onClick={() => setTimes(times.filter((_, j) => j !== i))} aria-label="Quitar">✕</button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => setTimes([...times, '08:00'])}>+ Añadir hora</button>
          {gaps.length > 0 && <div className="muted">Intervalos reales entre horas: {gaps.map((g) => `${g.from}→${g.to} ${fmtDuration(g.hours * 60)}`).join(' · ')}</div>}
          {warn.map((g) => <div className="alert warn" key={g.from}>{g.from} → {g.to} son {fmtDuration(g.hours * 60)}; la pauta indica {fmtDuration(g.expected * 60)}.</div>)}
        </div>
      )}
      <label className="field">Notas<textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn" disabled={busy || !f.name.trim() || !f.dose_text.trim()} onClick={() => void save()}>Guardar cambios</button>

      <div className="card stack">
        <h2>Verificación con el profesional</h2>
        <div className="muted">{med.verified ? `Verificada${med.verified_at ? ' el ' + fmtDateTime(med.verified_at, tz) : ''}${med.verified_note ? ' · ' + med.verified_note : ''}.` : 'Sin verificar. Los recordatorios permanecen desactivados hasta confirmar la pauta y el horario.'}</div>
        {!med.verified && <>
          <label className="field">Quién/cómo se verificó (p. ej. «farmacia, 30/10»)<input className="input" value={vNote} onChange={(e) => setVNote(e.target.value)} /></label>
          <button className="btn gold" disabled={busy || !vNote.trim()} onClick={() => void verify(true)}>Confirmo: pauta y horario verificados</button>
        </>}
        {med.verified && <button className="btn ghost" disabled={busy} onClick={() => void verify(false)}>Retirar verificación</button>}
      </div>
      <button className="btn ghost" onClick={() => void toggleActive()}>{med.active ? 'Desactivar medicamento (se conserva el historial)' : 'Reactivar medicamento'}</button>
    </Sheet>
  )
}
