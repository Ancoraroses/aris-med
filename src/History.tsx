import { useEffect, useMemo, useState } from 'react'
import { useApp } from './store'
import type { DoseHistoryEntry, DoseLog } from './types'
import { localDateStr, localTimeStr, zonedToDate } from './schedule'
import { Sheet, StatusChip, fmtDateTime, logTimeLabel, medTitle, useToast } from './ui'

const KIND_LABEL: Record<string, string> = { vomit: 'Vómito tras la toma', refusal: 'Rechazo de la toma', missed: 'Dosis no administrada', reaction: 'Reacción / síntoma', other: 'Otra' }
const CHANGE_LABEL: Record<string, string> = { create: 'Registro creado', correct: 'Corrección', void: 'Anulado' }

function csvCell(v: unknown) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }

export function History() {
  const { logs, meds, incidents, household, members, now } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [medId, setMedId] = useState('')
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<DoseLog | null>(null)
  const [incOpen, setIncOpen] = useState(false)
  const toast = useToast()
  const medName = (id: string | null) => meds.find((m) => m.id === id)?.name ?? '—'

  const sortKey = (l: DoseLog) => new Date(l.administered_at ?? l.approx_date ?? l.created_at).getTime()
  const filtered = useMemo(() => logs.filter((l) => {
    if (medId && l.medication_id !== medId) return false
    if (status && l.status !== status) return false
    const d = l.administered_at ? localDateStr(new Date(l.administered_at), tz) : l.approx_date ?? ''
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  }).sort((a, b) => sortKey(b) - sortKey(a)), [logs, medId, status, from, to, tz])

  const filteredInc = incidents.filter((i) => {
    if (medId && i.medication_id !== medId) return false
    const d = localDateStr(new Date(i.occurred_at), tz)
    return (!from || d >= from) && (!to || d <= to)
  })

  function exportCsv() {
    const head = ['Fecha', 'Hora', 'Medicamento', 'Dosis', 'Estado', 'Hora confirmada', 'Horario previsto', 'Administrada por', 'Observaciones', 'Versión']
    const rows = filtered.map((l) => [
      l.administered_at ? localDateStr(new Date(l.administered_at), tz) : l.approx_date ?? '',
      l.administered_at ? localTimeStr(new Date(l.administered_at), tz) : '',
      medName(l.medication_id), l.dose_text, l.status, l.time_confirmed ? 'sí' : 'no',
      l.scheduled_for ? localTimeStr(new Date(l.scheduled_for), tz) : '', l.administered_by_name, l.notes ?? '', l.version
    ])
    const inc = filteredInc.map((i) => [localDateStr(new Date(i.occurred_at), tz), localTimeStr(new Date(i.occurred_at), tz), medName(i.medication_id), '', 'INCIDENCIA: ' + KIND_LABEL[i.kind], '', '', i.created_by_name, i.description ?? '', ''])
    const csv = '﻿' + [head, ...rows, ...inc].map((r) => r.map(csvCell).join(';')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const file = new File([blob], `aris-med-historial-${localDateStr(now, tz)}.csv`, { type: 'text/csv' })
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    if (nav.canShare?.({ files: [file] })) { nav.share({ files: [file], title: 'Historial Aris Med' }).catch(() => undefined); return }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    toast.show('Historial descargado')
  }

  return (
    <div className="page" style={{ paddingTop: 20 }}>
      <h2 style={{ color: 'var(--navy)' }}>Historial</h2>
      <div className="card stack">
        <div className="row">
          <label className="field" style={{ flex: 1 }}>Desde<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field" style={{ flex: 1 }}>Hasta<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <label className="field">Medicamento
          <select className="input" value={medId} onChange={(e) => setMedId(e.target.value)}>
            <option value="">Todos</option>{meds.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="field">Estado
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option><option value="given">Administrada</option><option value="skipped">Omitida</option>
            <option value="pending_confirm">Pendiente de confirmar</option><option value="voided">Anulada</option>
          </select>
        </label>
        <div className="row">
          <button className="btn ghost small" style={{ flex: 1 }} onClick={exportCsv}>Exportar CSV</button>
          <button className="btn ghost small" style={{ flex: 1 }} onClick={() => window.print()}>Imprimir / PDF</button>
        </div>
      </div>

      <div className="card">
        <div className="no-print muted" style={{ marginBottom: 6 }}>{filtered.length} registro(s)</div>
        <div className="print-only-title" style={{ display: 'none' }}>Aris Med · Historial de medicación — {household?.child_name}</div>
        {filtered.length === 0 && <div className="muted">Sin registros con estos filtros.</div>}
        {filtered.map((l) => (
          <div className="hist-item" key={l.id} onClick={() => setDetail(l)}>
            <div className="row between"><b>{medName(l.medication_id)} · {l.dose_text}</b><StatusChip state={l.status} /></div>
            <div className="muted">{logTimeLabel(l, tz)} · {l.administered_by_name}{l.scheduled_for ? ` · previsto ${localTimeStr(new Date(l.scheduled_for), tz)}` : ''}</div>
            {l.notes && <div className="muted">“{l.notes}”</div>}
            {l.version > 1 && <div className="muted">Corregido (v{l.version})</div>}
          </div>
        ))}
      </div>

      <div className="row between"><div className="section-title">Incidencias</div><button className="btn small gold no-print" onClick={() => setIncOpen(true)}>+ Añadir</button></div>
      <div className="card">
        {filteredInc.length === 0 && <div className="muted">Sin incidencias.</div>}
        {filteredInc.map((i) => (
          <div className="hist-item" key={i.id} style={{ cursor: 'default' }}>
            <div className="row between"><b>{KIND_LABEL[i.kind]}</b><span className="muted">{fmtDateTime(i.occurred_at, tz)}</span></div>
            <div className="muted">{i.medication_id ? medName(i.medication_id) + ' · ' : ''}{i.created_by_name}{i.description ? ` — ${i.description}` : ''}</div>
          </div>
        ))}
      </div>

      {detail && <DetailSheet log={logs.find((l) => l.id === detail.id) ?? detail} onClose={() => setDetail(null)} onMsg={toast.show} members={members.length} />}
      {incOpen && <IncidentSheet onClose={() => setIncOpen(false)} onMsg={toast.show} />}
      {toast.node}
    </div>
  )
}

function DetailSheet({ log, onClose, onMsg }: { log: DoseLog; onClose: () => void; onMsg: (m: string) => void; members: number }) {
  const { meds, household, correctDose, voidDose, loadHistory, now } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const med = meds.find((m) => m.id === log.medication_id)
  const [hist, setHist] = useState<DoseHistoryEntry[]>([])
  const [editing, setEditing] = useState(false)
  const [when, setWhen] = useState(log.administered_at ? `${localDateStr(new Date(log.administered_at), tz)}T${localTimeStr(new Date(log.administered_at), tz)}` : `${log.approx_date ?? localDateStr(now, tz)}T12:00`)
  const [dose, setDose] = useState(log.dose_text)
  const [notes, setNotes] = useState(log.notes ?? '')
  const [status, setStatus] = useState<string>(log.status === 'voided' ? 'given' : log.status)
  const [confirmed, setConfirmed] = useState(log.time_confirmed || log.status === 'pending_confirm')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { void loadHistory(log.id).then(setHist) }, [log.id, log.version, loadHistory])

  async function save() {
    setBusy(true); setErr(null)
    const [d, t] = when.split('T')
    const iso = status === 'pending_confirm' && !confirmed ? null : zonedToDate(d, t, tz).toISOString()
    const r = await correctDose(log, { administered_at: iso, dose_text: dose, notes, status, time_confirmed: status === 'pending_confirm' ? false : confirmed, reason })
    setBusy(false)
    if (r.ok) { onMsg('Corrección guardada. El historial conserva la versión anterior.'); onClose(); return }
    setErr(r.code === 'version_conflict' ? 'Otra persona modificó este registro mientras lo editabas. Se ha recargado; revisa y vuelve a intentarlo.'
      : r.code === 'reason_required' ? 'Indica el motivo de la corrección.' : r.code === 'network' ? 'Sin conexión: no se guardó.' : `No se pudo guardar (${r.code}).`)
  }
  async function doVoid() {
    if (!reason.trim()) { setErr('Indica el motivo para anular.'); return }
    setBusy(true)
    const r = await voidDose(log, reason)
    setBusy(false)
    if (r.ok) { onMsg('Registro anulado (se conserva en el historial).'); onClose() } else setErr(`No se pudo anular (${r.code}).`)
  }

  return (
    <Sheet title={med ? medTitle(med) : 'Registro'} onClose={onClose}>
      <div className="card">
        <StatusChip state={log.status} />
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Dosis</dt><dd>{log.dose_text}</dd>
          <dt>Hora real</dt><dd>{logTimeLabel(log, tz)}</dd>
          <dt>Previsto</dt><dd>{log.scheduled_for ? fmtDateTime(log.scheduled_for, tz) : 'sin horario'}</dd>
          <dt>Administrada por</dt><dd>{log.administered_by_name}</dd>
          <dt>Observaciones</dt><dd>{log.notes ?? '—'}</dd>
        </dl>
      </div>
      {log.status !== 'voided' && !editing && <button className="btn" onClick={() => setEditing(true)}>Corregir / confirmar hora</button>}
      {editing && (
        <div className="stack">
          <div className="seg"><button className={status !== 'skipped' ? 'on' : ''} onClick={() => setStatus('given')}>Administrada</button><button className={status === 'skipped' ? 'on' : ''} onClick={() => setStatus('skipped')}>Omitida</button></div>
          <label className="field">Hora real<input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
          {log.status === 'pending_confirm' && <label className="switch"><span>Confirmo que esta es la hora exacta</span><input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); setStatus(e.target.checked ? 'given' : 'pending_confirm') }} /></label>}
          <label className="field">Dosis<input className="input" value={dose} onChange={(e) => setDose(e.target.value)} /></label>
          <label className="field">Observaciones<textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <label className="field">Motivo de la corrección (obligatorio)<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {err && <div className="alert bad">{err}</div>}
          <button className="btn gold" disabled={busy} onClick={() => void save()}>Guardar corrección</button>
          <button className="btn danger" disabled={busy} onClick={() => void doVoid()}>Anular este registro</button>
        </div>
      )}
      <div className="section-title">Historial de modificaciones</div>
      <div className="card">
        {hist.map((h) => (
          <div key={h.id} className="hist-item" style={{ cursor: 'default' }}>
            <b>{CHANGE_LABEL[h.change_type]}</b> <span className="muted">· {h.changed_by_name ?? '—'} · {fmtDateTime(h.changed_at, tz)}</span>
            {h.reason && <div className="muted">Motivo: {h.reason}</div>}
            {h.change_type === 'correct' && h.old_data && h.new_data && (
              <div className="muted">
                {h.old_data.administered_at !== h.new_data.administered_at && <div>Hora: {fmtDateTime(h.old_data.administered_at ?? null, tz)} → {fmtDateTime(h.new_data.administered_at ?? null, tz)}</div>}
                {h.old_data.status !== h.new_data.status && <div>Estado: {h.old_data.status} → {h.new_data.status}</div>}
                {h.old_data.dose_text !== h.new_data.dose_text && <div>Dosis: {h.old_data.dose_text} → {h.new_data.dose_text}</div>}
              </div>)}
          </div>
        ))}
        {hist.length === 0 && <div className="muted">Cargando…</div>}
      </div>
    </Sheet>
  )
}

function IncidentSheet({ onClose, onMsg }: { onClose: () => void; onMsg: (m: string) => void }) {
  const { meds, addIncident, now, household } = useApp()
  const tz = household?.timezone ?? 'Europe/Madrid'
  const [kind, setKind] = useState('vomit')
  const [medId, setMedId] = useState('')
  const [desc, setDesc] = useState('')
  const [when, setWhen] = useState(`${localDateStr(now, tz)}T${localTimeStr(now, tz)}`)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function save() {
    setBusy(true)
    const [d, t] = when.split('T')
    const e = await addIncident({ medication_id: medId || null, kind, description: desc, occurred_at: zonedToDate(d, t, tz).toISOString() })
    setBusy(false)
    if (e) setErr(e); else { onMsg('Incidencia registrada'); onClose() }
  }
  return (
    <Sheet title="Registrar incidencia" onClose={onClose}>
      <label className="field">Tipo<select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="field">Medicamento (opcional)<select className="input" value={medId} onChange={(e) => setMedId(e.target.value)}><option value="">—</option>{meds.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label className="field">Cuándo<input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
      <label className="field">Descripción<textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="muted">Una incidencia no cambia ninguna pauta. Ante dudas o síntomas, consulta con el pediatra.</div>
      {err && <div className="alert bad">{err}</div>}
      <button className="btn" disabled={busy} onClick={() => void save()}>Guardar</button>
    </Sheet>
  )
}
