// Edge Function: envía recordatorios push de dosis pendientes.
// Se invoca cada minuto (pg_cron + pg_net, o un cron externo). Despliegue: ver README.
//
// Garantías de diseño:
//  · Solo medicamentos ACTIVOS, de HORARIO FIJO y con pauta VERIFICADA.
//  · Solo para usuarios que activaron el recordatorio de ese medicamento (preferencias propias).
//  · No avisa si la toma ya está registrada (administrada, omitida o pendiente de confirmar).
//  · No duplica: la tabla reminder_log (clave única) se inserta ANTES de enviar.
//  · Misma "tag" para previo/hora/retraso: en el móvil se sustituye la notificación, no se acumula.
//
// Secretos necesarios (supabase secrets set ...): CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente.)
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'
import { localTimeStr, logForSlot, slotsBetween } from '../_shared/schedule.ts'
import type { DoseLog, Medication } from '../_shared/types.ts'

const MIN = 60_000

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 })

  const vapidPub = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPriv = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT')
  if (!vapidPub || !vapidPriv || !vapidSubject) return new Response('vapid not configured', { status: 500 })
  webpush.setVapidDetails(vapidSubject, vapidPub, vapidPriv)

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const now = new Date()
  const summary = { checked: 0, sent: 0, skipped_registered: 0, removed_subscriptions: 0, errors: [] as string[] }

  const { data: prefs, error: pe } = await sb.from('notification_prefs').select('*').eq('enabled', true)
  if (pe) return new Response(JSON.stringify({ error: pe.message }), { status: 500 })
  if (!prefs?.length) return Response.json(summary)

  const medIds = [...new Set(prefs.map((p) => p.medication_id))]
  const { data: meds } = await sb.from('medications').select('*')
    .in('id', medIds).eq('active', true).eq('verified', true).eq('schedule_mode', 'scheduled')
  if (!meds?.length) return Response.json(summary)

  const hhIds = [...new Set(meds.map((m) => m.household_id))]
  const { data: hhs } = await sb.from('households').select('id, child_name, timezone').in('id', hhIds)
  const hhMap = new Map((hhs ?? []).map((h) => [h.id, h]))

  const from = new Date(now.getTime() - 3 * 60 * MIN)
  const to = new Date(now.getTime() + 2 * 60 * MIN)
  const { data: logs } = await sb.from('dose_logs').select('*')
    .in('medication_id', meds.map((m) => m.id)).neq('status', 'voided')
    .gte('scheduled_for', from.toISOString()).lte('scheduled_for', to.toISOString())

  for (const med of meds as Medication[]) {
    const hh = hhMap.get(med.household_id)
    const tz = hh?.timezone ?? 'Europe/Madrid'
    const slots = slotsBetween(med, from, to, tz)
    for (const slot of slots) {
      summary.checked++
      if (logForSlot((logs ?? []) as DoseLog[], med.id, slot)) { summary.skipped_registered++; continue }
      for (const pref of prefs.filter((p) => p.medication_id === med.id)) {
        const lead = pref.lead_minutes as number
        const over = pref.overdue_minutes as number
        const dt = (now.getTime() - slot.getTime()) / MIN // >0 = ya pasó la hora
        let kind: 'before' | 'due' | 'overdue' | null = null
        if (lead > 0 && dt >= -lead && dt < 0) kind = 'before'
        else if (dt >= 0 && dt < 10) kind = 'due'
        else if (over > 0 && dt >= over && dt < over + 30) kind = 'overdue'
        if (!kind) continue

        // Reserva única: si ya existe, no se envía otra vez
        const { data: ins, error: ie } = await sb.from('reminder_log')
          .upsert({ user_id: pref.user_id, medication_id: med.id, scheduled_for: slot.toISOString(), kind },
            { onConflict: 'user_id,medication_id,scheduled_for,kind', ignoreDuplicates: true }).select()
        if (ie) { summary.errors.push(ie.message); continue }
        if (!ins || ins.length === 0) continue

        const hora = localTimeStr(slot, tz)
        const body = kind === 'before' ? `Toma prevista a las ${hora} (en ${Math.max(1, Math.round(-dt))} min). Dosis de la pauta: ${med.dose_text}.`
          : kind === 'due' ? `Toca la toma de las ${hora}. Dosis de la pauta: ${med.dose_text}. Regístrala al darla.`
          : `La toma de las ${hora} sigue sin registrar (hace ${Math.round(dt)} min). Regístrala como administrada u omitida.`
        const payload = JSON.stringify({ title: `${hh?.child_name ?? 'Aris'} · ${med.name}`, body, tag: `${med.id}-${slot.toISOString()}`, url: './' })

        const { data: subs } = await sb.from('push_subscriptions').select('*').eq('user_id', pref.user_id)
        for (const s of subs ?? []) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 900, urgency: 'high' })
            summary.sent++
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode
            if (code === 404 || code === 410) { await sb.from('push_subscriptions').delete().eq('id', s.id); summary.removed_subscriptions++ }
            else summary.errors.push(`push ${code ?? ''} ${(e as Error).message}`.slice(0, 200))
          }
        }
      }
    }
  }
  return Response.json(summary)
})
