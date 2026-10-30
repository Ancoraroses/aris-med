export type ScheduleMode = 'scheduled' | 'manual'
export type LogStatus = 'given' | 'skipped' | 'pending_confirm' | 'voided'

export interface Household {
  id: string
  name: string
  child_name: string
  child_weight_kg: number | null
  timezone: string
  max_members: number
}

export interface Member {
  household_id: string
  user_id: string
  display_name: string
}

export interface Medication {
  id: string
  household_id: string
  name: string
  strength: string | null
  dose_text: string
  frequency_text: string
  interval_hours: number | null
  duration_days: number | null
  schedule_mode: ScheduleMode
  times: string[]
  start_date: string // YYYY-MM-DD
  start_time: string | null // HH:MM:SS
  source_note: string | null
  notes: string | null
  verified: boolean
  verified_by: string | null
  verified_at: string | null
  verified_note: string | null
  active: boolean
  sort_order: number
}

export interface DoseLog {
  id: string
  household_id: string
  medication_id: string
  scheduled_for: string | null
  administered_at: string | null
  approx_date: string | null
  status: LogStatus
  time_confirmed: boolean
  dose_text: string
  notes: string | null
  administered_by: string | null
  administered_by_name: string
  recorded_by: string | null
  client_op_id: string
  version: number
  created_at: string
  updated_at: string
}

export interface DoseHistoryEntry {
  id: number
  dose_log_id: string
  changed_at: string
  changed_by_name: string | null
  change_type: 'create' | 'correct' | 'void'
  reason: string | null
  old_data: Partial<DoseLog> | null
  new_data: Partial<DoseLog> | null
}

export interface Incident {
  id: string
  household_id: string
  medication_id: string | null
  occurred_at: string
  kind: 'vomit' | 'refusal' | 'missed' | 'reaction' | 'other'
  description: string | null
  created_by_name: string
}

export interface NotifPref {
  user_id: string
  household_id: string
  medication_id: string
  enabled: boolean
  lead_minutes: number
  overdue_minutes: number
}

export interface RpcResult {
  ok: boolean
  code?: string
  duplicate_request?: boolean
  log?: DoseLog
}

export interface PendingOp {
  op_id: string
  medication_id: string
  medication_name: string
  scheduled_for: string | null
  administered_at: string
  dose_text: string
  notes: string | null
  status: 'given' | 'skipped'
  time_confirmed: boolean
  given_by: string | null
  given_by_name: string
  force: boolean
  queued_at: string
}
