-- Aris Med · Funciones RPC y triggers
-- Todas las escrituras sensibles pasan por aquí (SECURITY DEFINER + comprobación de pertenencia).

-- ───────────────────────── Trigger de medicamentos ─────────────────────────
create or replace function public.medications_guard()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  uname text;
  rel_changed boolean;
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.household_id := old.household_id;  -- no se puede mover de hogar

    -- "verified" solo se cambia mediante verify_medication()
    if new.verified is distinct from old.verified
       and coalesce(current_setting('aris.verify_rpc', true), '') <> '1' then
      new.verified := old.verified;
      new.verified_by := old.verified_by;
      new.verified_at := old.verified_at;
      new.verified_note := old.verified_note;
    end if;

    -- Cualquier cambio de pauta/horario anula la verificación (y por tanto los recordatorios)
    rel_changed :=
         new.name is distinct from old.name
      or new.strength is distinct from old.strength
      or new.dose_text is distinct from old.dose_text
      or new.frequency_text is distinct from old.frequency_text
      or new.interval_hours is distinct from old.interval_hours
      or new.duration_days is distinct from old.duration_days
      or new.schedule_mode is distinct from old.schedule_mode
      or new.times is distinct from old.times
      or new.start_date is distinct from old.start_date
      or new.start_time is distinct from old.start_time;
    if rel_changed and coalesce(current_setting('aris.verify_rpc', true), '') <> '1' then
      new.verified := false;
      new.verified_by := null;
      new.verified_at := null;
      new.verified_note := null;
    end if;

    select display_name into uname from public.household_members
      where household_id = old.household_id and user_id = auth.uid();
    insert into public.medication_history(household_id, medication_id, changed_by, changed_by_name, old_data, new_data)
    values (old.household_id, old.id, auth.uid(), uname, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger medications_guard_trg
before update on public.medications
for each row execute function public.medications_guard();

-- ───────────────────────── Hogar ─────────────────────────
create or replace function public.seed_initial_data(p_household uuid, p_user uuid, p_name text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  src text := 'Receta del 29/10/2026 (datos introducidos por la familia). Verificar con pediatría/farmacia.';
  med_dalsy uuid;
  med_apiretal uuid;
begin
  insert into public.medications
    (household_id, name, strength, dose_text, frequency_text, interval_hours, duration_days,
     schedule_mode, times, start_date, start_time, source_note, notes, sort_order)
  values
    (p_household, 'Augmentine suspensión oral', '100 mg/ml + 12,5 mg/ml', '4 ml', 'Cada 8 horas', 8, 10,
     'scheduled', array['06:00','14:00','22:00'], date '2026-10-29', time '22:00', src,
     'Horario 22:00 / 06:00 / 14:00 = PROPUESTA pendiente de confirmar con farmacia o pediatría (sueño y colegio). No es una pauta validada. El pediatra indicó cada 8 horas.', 1),
    (p_household, 'Bactroban nasal', '20 mg/g', '1 aplicación', 'Cada 8 horas', 8, 7,
     'scheduled', array['06:00','14:00','22:00'], date '2026-10-29', time '22:00', src,
     'Horario 22:00 / 06:00 / 14:00 = PROPUESTA pendiente de confirmar con farmacia o pediatría.', 2);

  insert into public.medications
    (household_id, name, strength, dose_text, frequency_text, interval_hours, duration_days,
     schedule_mode, times, start_date, start_time, source_note, notes, sort_order)
  values
    (p_household, 'Dalsy', '40 mg/ml', '4 ml', 'Cada 8 horas, según receta', 8, 3,
     'manual', '{}', date '2026-10-29', null, src,
     'Registro independiente de Apiretal. No se alterna automáticamente.', 3)
  returning id into med_dalsy;

  insert into public.medications
    (household_id, name, strength, dose_text, frequency_text, interval_hours, duration_days,
     schedule_mode, times, start_date, start_time, source_note, notes, sort_order)
  values
    (p_household, 'Apiretal', '100 mg/ml', '2,8 ml', 'Cada 6 horas, según receta', 6, 3,
     'manual', '{}', date '2026-10-29', null, src,
     'Registro independiente de Dalsy. No se alterna automáticamente.', 4)
  returning id into med_apiretal;

  insert into public.medications
    (household_id, name, strength, dose_text, frequency_text, interval_hours, duration_days,
     schedule_mode, times, start_date, start_time, source_note, notes, sort_order)
  values
    (p_household, 'Ultra-Levura', '250 mg', '1 sobre', 'Cada 24 horas', 24, 10,
     'manual', '{}', date '2026-10-29', null, src || ' Duración "10 días según receta".',
     null, 5);

  -- Datos iniciales aportados por la familia (a verificar)
  insert into public.dose_logs
    (household_id, medication_id, scheduled_for, administered_at, status, time_confirmed, dose_text,
     notes, administered_by, administered_by_name, client_op_id)
  values
    (p_household, med_dalsy, null, (timestamp '2026-10-29 15:30') at time zone 'Europe/Madrid', 'given', true, '4 ml',
     'Última toma conocida aportada por la familia al preparar el registro. Verificar.', null,
     'Dato inicial familiar', gen_random_uuid());

  insert into public.dose_logs
    (household_id, medication_id, scheduled_for, administered_at, approx_date, status, time_confirmed, dose_text,
     notes, administered_by, administered_by_name, client_op_id)
  values
    (p_household, med_apiretal, null, null, date '2026-10-29', 'pending_confirm', false, '2,8 ml',
     'Administrado el 29/10/2026 pero falta confirmar la hora exacta. Corrige este registro con la hora real.', null,
     'Dato inicial familiar', gen_random_uuid());

  insert into public.dose_log_history(dose_log_id, household_id, changed_by, changed_by_name, change_type, reason, new_data)
  select id, household_id, p_user, p_name, 'create', 'Dato inicial aportado por la familia', to_jsonb(dose_logs)
  from public.dose_logs where household_id = p_household;
end;
$$;

create or replace function public.create_household(p_name text, p_child_name text, p_display_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  hid uuid;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'already_in_household';
  end if;
  insert into public.households(name, child_name, child_weight_kg, created_by)
  values (coalesce(nullif(trim(p_name), ''), 'Familia'), coalesce(nullif(trim(p_child_name), ''), 'Aris'), 19, uid)
  returning id into hid;
  insert into public.household_members(household_id, user_id, display_name)
  values (hid, uid, trim(p_display_name));
  perform public.seed_initial_data(hid, uid, trim(p_display_name));
  return hid;
end;
$$;

create or replace function public.create_invitation(p_household uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  c text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not public.is_member(p_household) then raise exception 'forbidden'; end if;
  -- anula invitaciones anteriores sin usar
  update public.invitations set expires_at = now()
    where household_id = p_household and used_at is null and expires_at > now();
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.invitations(household_id, code) values (p_household, c);
  return c;
end;
$$;

create or replace function public.accept_invitation(p_code text, p_display_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  inv public.invitations;
  hh public.households;
  n int;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'already_in_household';
  end if;
  select * into inv from public.invitations
    where code = upper(trim(p_code)) for update;
  if not found or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'invalid_or_expired_invitation';
  end if;
  select * into hh from public.households where id = inv.household_id for update;
  select count(*) into n from public.household_members where household_id = inv.household_id;
  if n >= hh.max_members then raise exception 'household_full'; end if;
  insert into public.household_members(household_id, user_id, display_name)
    values (inv.household_id, uid, trim(p_display_name));
  update public.invitations set used_by = uid, used_at = now() where id = inv.id;
  return inv.household_id;
end;
$$;

create or replace function public.verify_medication(p_medication uuid, p_verified boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  select household_id into hid from public.medications where id = p_medication;
  if hid is null then raise exception 'medication_not_found'; end if;
  if not public.is_member(hid) then raise exception 'forbidden'; end if;
  perform set_config('aris.verify_rpc', '1', true);
  update public.medications
    set verified = p_verified,
        verified_by = case when p_verified then auth.uid() end,
        verified_at = case when p_verified then now() end,
        verified_note = case when p_verified then nullif(trim(p_note), '') end
    where id = p_medication;
end;
$$;

-- ───────────────────────── Registrar toma ─────────────────────────
-- Devuelve jsonb: {ok:true, log} | {ok:false, code, log?}
--  codes: slot_already_recorded | possible_duplicate | future_time | invalid_status
create or replace function public.register_dose(
  p_medication_id uuid,
  p_scheduled_for timestamptz,
  p_administered_at timestamptz,
  p_dose_text text,
  p_notes text default null,
  p_status text default 'given',
  p_time_confirmed boolean default true,
  p_client_op_id uuid default gen_random_uuid(),
  p_force boolean default false,
  p_given_by uuid default null          -- miembro del hogar que la administró (por defecto, quien registra)
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  med public.medications;
  uname text;
  existing public.dose_logs;
  rec public.dose_logs;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into med from public.medications where id = p_medication_id;
  if not found then raise exception 'medication_not_found'; end if;
  if not public.is_member(med.household_id) then raise exception 'forbidden'; end if;

  -- Reintento idempotente (mismo clic reenviado tras perder conexión)
  select * into existing from public.dose_logs where client_op_id = p_client_op_id;
  if found then
    if existing.household_id <> med.household_id then raise exception 'forbidden'; end if;
    return jsonb_build_object('ok', true, 'duplicate_request', true, 'log', to_jsonb(existing));
  end if;

  if p_status not in ('given','skipped') then
    return jsonb_build_object('ok', false, 'code', 'invalid_status');
  end if;
  if p_administered_at is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_time');
  end if;
  if p_administered_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'future_time');
  end if;

  -- Serializa registros concurrentes del mismo medicamento
  perform pg_advisory_xact_lock(hashtextextended(p_medication_id::text, 0));

  if p_scheduled_for is not null then
    select * into existing from public.dose_logs
      where medication_id = p_medication_id and scheduled_for = p_scheduled_for and status <> 'voided';
    if found then
      return jsonb_build_object('ok', false, 'code', 'slot_already_recorded', 'log', to_jsonb(existing));
    end if;
  end if;

  if p_status = 'given' and not p_force then
    select * into existing from public.dose_logs
      where medication_id = p_medication_id and status = 'given'
        and administered_at is not null
        and abs(extract(epoch from (administered_at - p_administered_at))) < 600
      order by administered_at desc limit 1;
    if found then
      return jsonb_build_object('ok', false, 'code', 'possible_duplicate', 'log', to_jsonb(existing));
    end if;
  end if;

  select display_name into uname from public.household_members
    where household_id = med.household_id and user_id = coalesce(p_given_by, uid);
  if uname is null then raise exception 'given_by_not_member'; end if;

  begin
    insert into public.dose_logs
      (household_id, medication_id, scheduled_for, administered_at, status, time_confirmed, dose_text,
       notes, administered_by, administered_by_name, recorded_by, client_op_id)
    values
      (med.household_id, p_medication_id, p_scheduled_for, p_administered_at, p_status,
       coalesce(p_time_confirmed, true), coalesce(nullif(trim(p_dose_text), ''), med.dose_text),
       nullif(trim(p_notes), ''), coalesce(p_given_by, uid), uname, uid, p_client_op_id)
    returning * into rec;
  exception when unique_violation then
    -- Red de seguridad: la restricción única de la BD gana siempre
    select * into existing from public.dose_logs
      where medication_id = p_medication_id and scheduled_for = p_scheduled_for and status <> 'voided';
    return jsonb_build_object('ok', false, 'code', 'slot_already_recorded', 'log', to_jsonb(existing));
  end;

  insert into public.dose_log_history(dose_log_id, household_id, changed_by, changed_by_name, change_type, new_data)
  values (rec.id, rec.household_id, uid,
          (select display_name from public.household_members where household_id = rec.household_id and user_id = uid),
          'create', to_jsonb(rec));

  return jsonb_build_object('ok', true, 'log', to_jsonb(rec));
end;
$$;

-- ───────────────────────── Corregir / anular ─────────────────────────
create or replace function public.correct_dose(
  p_log_id uuid,
  p_expected_version int,
  p_administered_at timestamptz,
  p_dose_text text,
  p_notes text,
  p_status text,
  p_time_confirmed boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur public.dose_logs;
  upd public.dose_logs;
  uname text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into cur from public.dose_logs where id = p_log_id for update;
  if not found then raise exception 'log_not_found'; end if;
  if not public.is_member(cur.household_id) then raise exception 'forbidden'; end if;
  if cur.status = 'voided' then
    return jsonb_build_object('ok', false, 'code', 'already_voided', 'log', to_jsonb(cur));
  end if;
  if cur.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'version_conflict', 'log', to_jsonb(cur));
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;
  if p_status not in ('given','skipped','pending_confirm') then
    return jsonb_build_object('ok', false, 'code', 'invalid_status');
  end if;
  if p_administered_at is not null and p_administered_at > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'future_time');
  end if;
  if p_administered_at is null and not (p_status = 'pending_confirm' and cur.approx_date is not null) then
    return jsonb_build_object('ok', false, 'code', 'invalid_time');
  end if;

  select display_name into uname from public.household_members
    where household_id = cur.household_id and user_id = uid;

  update public.dose_logs set
    administered_at = p_administered_at,
    dose_text = coalesce(nullif(trim(p_dose_text), ''), dose_text),
    notes = nullif(trim(p_notes), ''),
    status = p_status,
    time_confirmed = coalesce(p_time_confirmed, time_confirmed),
    version = version + 1,
    updated_at = now()
  where id = p_log_id
  returning * into upd;

  insert into public.dose_log_history
    (dose_log_id, household_id, changed_by, changed_by_name, change_type, reason, old_data, new_data)
  values (p_log_id, cur.household_id, uid, uname, 'correct', trim(p_reason), to_jsonb(cur), to_jsonb(upd));

  return jsonb_build_object('ok', true, 'log', to_jsonb(upd));
end;
$$;

create or replace function public.void_dose(p_log_id uuid, p_expected_version int, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cur public.dose_logs;
  upd public.dose_logs;
  uname text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into cur from public.dose_logs where id = p_log_id for update;
  if not found then raise exception 'log_not_found'; end if;
  if not public.is_member(cur.household_id) then raise exception 'forbidden'; end if;
  if cur.status = 'voided' then
    return jsonb_build_object('ok', false, 'code', 'already_voided', 'log', to_jsonb(cur));
  end if;
  if cur.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'version_conflict', 'log', to_jsonb(cur));
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'reason_required');
  end if;
  select display_name into uname from public.household_members
    where household_id = cur.household_id and user_id = uid;
  update public.dose_logs set status = 'voided', version = version + 1, updated_at = now()
    where id = p_log_id returning * into upd;
  insert into public.dose_log_history
    (dose_log_id, household_id, changed_by, changed_by_name, change_type, reason, old_data, new_data)
  values (p_log_id, cur.household_id, uid, uname, 'void', trim(p_reason), to_jsonb(cur), to_jsonb(upd));
  return jsonb_build_object('ok', true, 'log', to_jsonb(upd));
end;
$$;

create or replace function public.register_incident(
  p_household uuid, p_medication uuid, p_kind text, p_description text, p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  uname text;
  nid uuid;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not public.is_member(p_household) then raise exception 'forbidden'; end if;
  if p_medication is not null and not exists
     (select 1 from public.medications where id = p_medication and household_id = p_household) then
    raise exception 'medication_not_found';
  end if;
  select display_name into uname from public.household_members where household_id = p_household and user_id = uid;
  insert into public.incidents(household_id, medication_id, occurred_at, kind, description, created_by, created_by_name)
  values (p_household, p_medication, coalesce(p_occurred_at, now()), p_kind, nullif(trim(p_description), ''), uid, coalesce(uname, 'Desconocido'))
  returning id into nid;
  return nid;
end;
$$;
