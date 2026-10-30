import { describe, it, expect } from 'vitest'
import {
  zonedToDate, slotsBetween, configuredGaps, gapWarnings, checkInterval, treatmentDays,
  treatmentEnd, slotState, localDateStr, localTimeStr, deviationMinutes, fmtDuration
} from './schedule'
import type { Medication, DoseLog } from './types'

const base: Medication = {
  id: 'm1', household_id: 'h', name: 'Augmentine', strength: null, dose_text: '4 ml', frequency_text: 'Cada 8 horas',
  interval_hours: 8, duration_days: 10, schedule_mode: 'scheduled', times: ['06:00', '14:00', '22:00'],
  start_date: '2026-10-29', start_time: '22:00:00', source_note: null, notes: null, verified: false,
  verified_by: null, verified_at: null, verified_note: null, active: true, sort_order: 1
}

describe('zona horaria Europe/Madrid', () => {
  it('29/10/2026 15:30 es UTC+1 (CET) → 14:30Z', () => {
    expect(zonedToDate('2026-10-29', '15:30').toISOString()).toBe('2026-10-29T14:30:00.000Z')
  })
  it('verano: 15/07/2026 15:30 es UTC+2 → 13:30Z', () => {
    expect(zonedToDate('2026-07-15', '15:30').toISOString()).toBe('2026-07-15T13:30:00.000Z')
  })
  it('formatea hora local', () => {
    expect(localTimeStr(new Date('2026-10-29T21:00:00Z'))).toBe('22:00')
    expect(localDateStr(new Date('2026-10-29T23:30:00Z'))).toBe('2026-10-30')
  })
})

describe('horarios 22:00 / 06:00 / 14:00', () => {
  it('los intervalos configurados son de 8 h y no hay avisos', () => {
    expect(configuredGaps(base.times).map((g) => g.hours)).toEqual([8, 8, 8])
    expect(gapWarnings(base)).toEqual([])
  })
  it('avisa cuando una hora rompe el intervalo', () => {
    const w = gapWarnings({ times: ['06:00', '15:00', '22:00'], interval_hours: 8 })
    // 06→15 = 9 h, 15→22 = 7 h (avisan); 22→06 = 8 h (correcto)
    expect(w.length).toBe(2)
    expect(w.map((x) => x.hours).sort()).toEqual([7, 9])
  })
  it('primer día: solo desde las 22:00 (Augmentine no iniciado antes)', () => {
    const from = zonedToDate('2026-10-29', '00:00')
    const to = zonedToDate('2026-10-30', '23:59')
    const s = slotsBetween(base, from, to).map((d) => localDateStr(d) + ' ' + localTimeStr(d))
    expect(s).toEqual(['2026-10-29 22:00', '2026-10-30 06:00', '2026-10-30 14:00', '2026-10-30 22:00'])
  })
  it('10 días = 30 tomas exactas, sin prolongar el tratamiento', () => {
    const s = slotsBetween(base, zonedToDate('2026-10-29', '00:00'), zonedToDate('2026-12-31', '00:00'))
    expect(s.length).toBe(30)
    expect(localDateStr(s[29]) + ' ' + localTimeStr(s[29])).toBe('2026-11-08 14:00')
    expect(localDateStr(treatmentEnd(base)!)).toBe('2026-11-08')
  })
  it('cruza el cambio de hora sin perder ni duplicar tomas (fin horario de invierno 25/10 no afecta, probamos 29/03/2027)', () => {
    const med = { ...base, start_date: '2027-03-27', start_time: '06:00:00', duration_days: 3 }
    const s = slotsBetween(med, zonedToDate('2027-03-27', '00:00'), zonedToDate('2027-04-05', '00:00'))
    expect(s.length).toBe(9)
    expect(s.map((d) => localTimeStr(d))).toEqual(['06:00','14:00','22:00','06:00','14:00','22:00','06:00','14:00','22:00'])
  })
  it('modo manual no genera horarios', () => {
    expect(slotsBetween({ ...base, schedule_mode: 'manual' }, zonedToDate('2026-10-29', '00:00'), zonedToDate('2026-11-05', '00:00'))).toEqual([])
  })
})

describe('días de tratamiento', () => {
  it('antes de empezar', () => {
    expect(treatmentDays(base, zonedToDate('2026-10-29', '19:55')).state).toBe('not_started')
  })
  it('día 2 de 10', () => {
    const t = treatmentDays(base, zonedToDate('2026-10-30', '10:00'))
    expect(t).toMatchObject({ state: 'running', day: 2, total: 10, remaining: 8 })
  })
  it('terminado, no se prolonga', () => {
    expect(treatmentDays(base, zonedToDate('2026-11-09', '00:00')).state).toBe('finished')
  })
})

describe('intervalos reales', () => {
  const t = (h: string) => zonedToDate('2026-10-30', h)
  it('8 h exactas → ok', () => {
    expect(checkInterval(t('06:00'), t('14:00'), 8).level).toBe('ok')
  })
  it('dentro de ±15 min → ok', () => {
    expect(checkInterval(t('06:00'), t('14:10'), 8).level).toBe('ok')
  })
  it('antes de tiempo → early con diferencia', () => {
    const c = checkInterval(t('06:00'), t('12:30'), 8)
    expect(c.level).toBe('early'); expect(c.diffMinutes).toBe(-90); expect(c.minutes).toBe(390)
  })
  it('muy tarde → late (no se compensa)', () => {
    expect(checkInterval(t('06:00'), t('16:00'), 8).level).toBe('late')
  })
  it('sin toma previa → none', () => {
    expect(checkInterval(null, t('14:00'), 8).level).toBe('none')
  })
  it('desviación previsto vs efectivo', () => {
    expect(deviationMinutes(t('22:00'), t('22:25'))).toBe(25)
    expect(fmtDuration(390)).toBe('6 h 30 min')
  })
})

describe('estado de la toma', () => {
  const slot = zonedToDate('2026-10-29', '22:00')
  const mk = (status: DoseLog['status']): DoseLog => ({
    id: 'l', household_id: 'h', medication_id: 'm1', scheduled_for: slot.toISOString(), administered_at: slot.toISOString(),
    approx_date: null, status, time_confirmed: true, dose_text: '4 ml', notes: null, administered_by: null,
    administered_by_name: 'x', recorded_by: null, client_op_id: 'o', version: 1, created_at: '', updated_at: ''
  })
  it('futura = upcoming', () => expect(slotState(undefined, slot, zonedToDate('2026-10-29', '21:00'))).toBe('upcoming'))
  it('recién llegada = pending', () => expect(slotState(undefined, slot, zonedToDate('2026-10-29', '22:10'))).toBe('pending'))
  it('pasada de margen = overdue (no se marca como omitida sola)', () => expect(slotState(undefined, slot, zonedToDate('2026-10-30', '01:00'))).toBe('overdue'))
  it('con registro → given / skipped / pending_confirm', () => {
    expect(slotState(mk('given'), slot, new Date())).toBe('given')
    expect(slotState(mk('skipped'), slot, new Date())).toBe('skipped')
    expect(slotState(mk('pending_confirm'), slot, new Date())).toBe('pending_confirm')
  })
})
