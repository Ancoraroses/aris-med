-- Aris Med · Esquema base
-- Herramienta de REGISTRO familiar. No es un sistema de prescripción.

-- ───────────────────────── Hogar y miembros ─────────────────────────
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  child_name text not null default 'Aris',
  child_weight_kg numeric(5,2),              -- solo informativo; NUNCA se usa para calcular dosis
  timezone text not null default 'Europe/Madrid',
  max_members int not null default 2 check (max_members between 1 and 6),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 40),
  role text not null default 'parent',
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
-- Un usuario solo puede pertenecer a un hogar (simplifica la app y el control de acceso).
create unique index household_members_one_household on public.household_members(user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code text not null unique,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id),
  used_at timestamptz
);

-- Función de pertenencia (SECURITY DEFINER para evitar recursión en RLS)
create or replace function public.is_member(p_household uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id = p_household and user_id = auth.uid()
  );
$$;

-- ───────────────────────── Medicación ─────────────────────────
create table public.medications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  strength text,                               -- p. ej. "100 mg/ml + 12,5 mg/ml"
  dose_text text not null,                     -- dosis tal y como figura en la pauta (texto, no se calcula)
  frequency_text text not null,                -- p. ej. "Cada 8 horas"
  interval_hours numeric(5,2) check (interval_hours is null or interval_hours > 0),
  duration_days int check (duration_days is null or duration_days > 0),
  schedule_mode text not null default 'manual' check (schedule_mode in ('scheduled','manual')),
  times text[] not null default '{}',          -- horas "HH:MM" locales (solo scheduled)
  start_date date not null,
  start_time time,                             -- hora de la primera toma (opcional)
  source_note text,
  notes text,
  verified boolean not null default false,     -- pauta y horario confirmados con profesional sanitario
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  verified_note text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index medications_household_idx on public.medications(household_id);

create table public.medication_history (
  id bigint generated always as identity primary key,
  household_id uuid not null,
  medication_id uuid not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  changed_by_name text,
  old_data jsonb,
  new_data jsonb
);
create index medication_history_med_idx on public.medication_history(medication_id, changed_at desc);

-- ───────────────────────── Registro de tomas ─────────────────────────
create table public.dose_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete cascade,
  scheduled_for timestamptz,                   -- horario PREVISTO (null en tomas manuales)
  administered_at timestamptz,                 -- hora EFECTIVA
  approx_date date,                            -- solo si la hora exacta falta (pending_confirm)
  status text not null check (status in ('given','skipped','pending_confirm','voided')),
  time_confirmed boolean not null default true,
  dose_text text not null,                     -- dosis de la pauta en el momento del registro
  notes text,
  administered_by uuid references auth.users(id),   -- quién la dio (miembro del hogar)
  administered_by_name text not null,
  recorded_by uuid references auth.users(id),       -- quién la registró en la app
  client_op_id uuid not null unique,           -- idempotencia ante reintentos
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dose_logs_time_present check (
    administered_at is not null or (status = 'pending_confirm' and approx_date is not null)
  )
);
create index dose_logs_med_time_idx on public.dose_logs(medication_id, administered_at desc);
create index dose_logs_household_time_idx on public.dose_logs(household_id, created_at desc);

-- RESTRICCIÓN CLAVE: una sola toma activa por medicamento y horario previsto,
-- aunque dos móviles pulsen a la vez.
create unique index dose_logs_one_per_slot
  on public.dose_logs(medication_id, scheduled_for)
  where scheduled_for is not null and status <> 'voided';

create table public.dose_log_history (
  id bigint generated always as identity primary key,
  dose_log_id uuid not null references public.dose_logs(id) on delete cascade,
  household_id uuid not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  changed_by_name text,
  change_type text not null check (change_type in ('create','correct','void')),
  reason text,
  old_data jsonb,
  new_data jsonb
);
create index dose_log_history_log_idx on public.dose_log_history(dose_log_id, changed_at);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  medication_id uuid references public.medications(id) on delete set null,
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in ('vomit','refusal','missed','reaction','other')),
  description text,
  created_by uuid not null default auth.uid(),
  created_by_name text not null,
  created_at timestamptz not null default now()
);
create index incidents_household_idx on public.incidents(household_id, occurred_at desc);

-- ───────────────────────── Notificaciones (por progenitor) ─────────────────────────
create table public.notification_prefs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete cascade,
  enabled boolean not null default false,
  lead_minutes int not null default 10 check (lead_minutes between 0 and 120),     -- aviso previo
  overdue_minutes int not null default 15 check (overdue_minutes between 0 and 240), -- aviso posterior
  primary key (user_id, medication_id)
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Evita avisos duplicados: la función de recordatorios inserta aquí antes de enviar.
create table public.reminder_log (
  user_id uuid not null,
  medication_id uuid not null,
  scheduled_for timestamptz not null,
  kind text not null check (kind in ('before','due','overdue')),
  sent_at timestamptz not null default now(),
  primary key (user_id, medication_id, scheduled_for, kind)
);
