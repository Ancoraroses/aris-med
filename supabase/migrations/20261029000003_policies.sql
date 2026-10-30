-- Aris Med · Seguridad (RLS), permisos y tiempo real

alter table public.households          enable row level security;
alter table public.household_members   enable row level security;
alter table public.invitations         enable row level security;
alter table public.medications         enable row level security;
alter table public.medication_history  enable row level security;
alter table public.dose_logs           enable row level security;
alter table public.dose_log_history    enable row level security;
alter table public.incidents           enable row level security;
alter table public.notification_prefs  enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.reminder_log        enable row level security;  -- sin políticas: solo service_role

-- Nada para usuarios anónimos
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Lecturas: solo miembros del hogar
create policy households_select on public.households
  for select to authenticated using (public.is_member(id));
create policy households_update on public.households
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

create policy members_select on public.household_members
  for select to authenticated using (public.is_member(household_id));
create policy members_update_self on public.household_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy invitations_select on public.invitations
  for select to authenticated using (public.is_member(household_id));

create policy medications_select on public.medications
  for select to authenticated using (public.is_member(household_id));
create policy medications_insert on public.medications
  for insert to authenticated with check (public.is_member(household_id));
create policy medications_update on public.medications
  for update to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));

create policy medication_history_select on public.medication_history
  for select to authenticated using (public.is_member(household_id));

create policy dose_logs_select on public.dose_logs
  for select to authenticated using (public.is_member(household_id));
create policy dose_log_history_select on public.dose_log_history
  for select to authenticated using (public.is_member(household_id));
create policy incidents_select on public.incidents
  for select to authenticated using (public.is_member(household_id));

create policy notif_prefs_all on public.notification_prefs
  for all to authenticated
  using (user_id = auth.uid() and public.is_member(household_id))
  with check (user_id = auth.uid() and public.is_member(household_id));
create policy push_subs_all on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid() and public.is_member(household_id))
  with check (user_id = auth.uid() and public.is_member(household_id));

-- Escrituras de tomas/incidencias/hogar/invitaciones SOLO mediante funciones RPC
revoke insert, update, delete on public.dose_logs         from authenticated;
revoke insert, update, delete on public.dose_log_history  from authenticated;
revoke insert, update, delete on public.incidents         from authenticated;
revoke insert, update, delete on public.invitations       from authenticated;
revoke insert, delete         on public.households        from authenticated;
revoke insert, delete         on public.household_members from authenticated;
revoke insert, update, delete on public.medication_history from authenticated;
revoke all on public.reminder_log from authenticated;
-- columnas de households/household_members que el cliente puede modificar
revoke update on public.household_members from authenticated;
grant  update (display_name) on public.household_members to authenticated;
revoke update on public.households from authenticated;
grant  update (name, child_name, child_weight_kg) on public.households to authenticated;
-- no borrar medicamentos desde el cliente (se desactivan)
revoke delete on public.medications from authenticated;

-- Ejecución de funciones
revoke all on function public.is_member(uuid)                      from public, anon;
revoke all on function public.seed_initial_data(uuid, uuid, text)  from public, anon, authenticated;
revoke all on function public.create_household(text, text, text)  from public, anon;
revoke all on function public.create_invitation(uuid)              from public, anon;
revoke all on function public.accept_invitation(text, text)        from public, anon;
revoke all on function public.verify_medication(uuid, boolean, text) from public, anon;
revoke all on function public.register_dose(uuid, timestamptz, timestamptz, text, text, text, boolean, uuid, boolean, uuid) from public, anon;
revoke all on function public.correct_dose(uuid, int, timestamptz, text, text, text, boolean, text) from public, anon;
revoke all on function public.void_dose(uuid, int, text)           from public, anon;
revoke all on function public.register_incident(uuid, uuid, text, text, timestamptz) from public, anon;

grant execute on function public.is_member(uuid)                      to authenticated;
grant execute on function public.create_household(text, text, text)  to authenticated;
grant execute on function public.create_invitation(uuid)              to authenticated;
grant execute on function public.accept_invitation(text, text)        to authenticated;
grant execute on function public.verify_medication(uuid, boolean, text) to authenticated;
grant execute on function public.register_dose(uuid, timestamptz, timestamptz, text, text, text, boolean, uuid, boolean, uuid) to authenticated;
grant execute on function public.correct_dose(uuid, int, timestamptz, text, text, text, boolean, text) to authenticated;
grant execute on function public.void_dose(uuid, int, text)           to authenticated;
grant execute on function public.register_incident(uuid, uuid, text, text, timestamptz) to authenticated;

-- Tiempo real (si existe la publicación de Supabase)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dose_logs;
    alter publication supabase_realtime add table public.medications;
    alter publication supabase_realtime add table public.incidents;
  end if;
end $$;
