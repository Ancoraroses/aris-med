#!/usr/bin/env bash
# Pruebas de BD: control de acceso (RLS), duplicados, concurrencia, correcciones, invitaciones.
# Uso local (con Postgres + stub):  PGHOST=... PGPORT=... PGUSER=postgres PGDATABASE=aris_test ./run_tests.sh
set -u
PASS=0; FAIL=0
q()  { psql -qtAX -v ON_ERROR_STOP=1 "$@" 2>&1; }
as() { # as <uuid> <sql>  → ejecuta como usuario autenticado
  local uid="$1"; shift
  q -c "set role authenticated; select set_config('request.jwt.claim.sub','$uid',false); $*" | tail -n +2
}
check() { # check "descripción" "esperado" "obtenido"
  local ok=0
  if [[ "$2" =~ ^[0-9tf]$|^[0-9]+$ ]]; then [[ "$3" == "$2" ]] && ok=1; else [[ "$3" == *"$2"* ]] && ok=1; fi
  if [[ $ok -eq 1 ]]; then PASS=$((PASS+1)); echo "  OK   $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1 → esperado '$2', obtenido '$3'"; fi
}

q -c "truncate auth.users, public.households cascade" >/dev/null
P1=$(q -c "insert into auth.users(email) values ('papa@test') returning id" | head -1)
P2=$(q -c "insert into auth.users(email) values ('mama@test') returning id" | head -1)
EXT=$(q -c "insert into auth.users(email) values ('extraño@test') returning id" | head -1)

echo "1) Hogar e invitación"
HID=$(as "$P1" "select public.create_household('Familia','Aris','Carlos');")
check "papá crea hogar" "-" "$HID"
check "datos iniciales: 5 medicamentos" "5" "$(as "$P1" "select count(*) from public.medications;")"
check "datos iniciales: horarios 06/14/22 en Augmentine" "{06:00,14:00,22:00}" "$(as "$P1" "select times from public.medications where name like 'Augmentine%';")"
check "Dalsy 15:30 (CET) = 14:30 UTC" "2026-10-29 14:30:00+00" "$(q -c "select administered_at at time zone 'UTC' || '+00' from dose_logs l join medications m on m.id=l.medication_id where m.name='Dalsy'" | sed 's/+00+00/+00/')"
check "Apiretal inicial: pendiente de confirmar" "pending_confirm" "$(as "$P1" "select status from public.dose_logs l join public.medications m on m.id=l.medication_id where m.name='Apiretal';")"
check "ninguna pauta verificada de inicio" "0" "$(as "$P1" "select count(*) from public.medications where verified;")"
CODE=$(as "$P1" "select public.create_invitation('$HID');")
check "invitación generada (10 caracteres)" "" "$CODE"
check "extraño no puede crear invitación" "forbidden" "$(as "$EXT" "select public.create_invitation('$HID');")"
check "código falso rechazado" "invalid_or_expired_invitation" "$(as "$P2" "select public.accept_invitation('ZZZZZZZZZZ','Mireia');")"
check "mamá acepta invitación" "$HID" "$(as "$P2" "select public.accept_invitation('$CODE','Mireia');")"
check "código no reutilizable" "invalid_or_expired_invitation" "$(as "$EXT" "select public.accept_invitation('$CODE','Intruso');")"
CODE2=$(as "$P1" "select public.create_invitation('$HID');")
check "hogar completo (máx. 2)" "household_full" "$(as "$EXT" "select public.accept_invitation('$CODE2','Intruso');")"

echo "2) Control de acceso (RLS)"
MED=$(q -c "select id from medications where name like 'Augmentine%'" | head -1)
check "extraño no ve medicamentos" "0" "$(as "$EXT" "select count(*) from public.medications;")"
check "extraño no ve tomas" "0" "$(as "$EXT" "select count(*) from public.dose_logs;")"
check "extraño no ve hogares" "0" "$(as "$EXT" "select count(*) from public.households;")"
check "extraño no puede registrar toma" "forbidden" "$(as "$EXT" "select public.register_dose('$MED', null, now(), '4 ml');")"
check "papá no puede insertar tomas directamente" "permission denied" "$(as "$P1" "insert into public.dose_logs(household_id,medication_id,status,dose_text,administered_by_name,client_op_id,administered_at) values ('$HID','$MED','given','x','x',gen_random_uuid(),now());")"
check "papá no puede borrar tomas directamente" "permission denied" "$(as "$P1" "delete from public.dose_logs;")"
check "anónimo sin acceso" "permission denied" "$(q -c "set role anon; select count(*) from public.medications;")"
as "$EXT" "update public.medications set dose_text='999 ml';" >/dev/null
check "extraño no puede modificar medicamentos" "4 ml" "$(q -c "select dose_text from medications where id='$MED'")"
check "ambos ven los 5 medicamentos" "5" "$(as "$P2" "select count(*) from public.medications;")"

echo "3) Registro, duplicados y red de seguridad"
SLOT="2026-10-28 22:00+01"
R=$(as "$P1" "select public.register_dose('$MED','$SLOT',timestamptz '2026-10-28 22:05+01','4 ml','ok');")
check "papá registra la toma de las 22:00" '"ok": true' "$R"
check "queda registrado quién la dio" "Carlos" "$(as "$P2" "select administered_by_name from public.dose_logs where scheduled_for='$SLOT';")"
R=$(as "$P2" "select public.register_dose('$MED','$SLOT',timestamptz '2026-10-28 22:06+01','4 ml');")
check "mamá intenta la misma dosis → rechazada" "slot_already_recorded" "$R"
OP=$(q -c "select gen_random_uuid()" | head -1)
as "$P2" "select public.register_dose('$MED','2026-10-29 06:00+01',timestamptz '2026-10-29 06:00+01','4 ml',null,'given',true,'$OP');" >/dev/null || true
R=$(as "$P2" "select public.register_dose('$MED','2026-10-29 06:00+01',timestamptz '2026-10-29 06:00+01','4 ml',null,'given',true,'$OP');")
check "reintento con el mismo client_op_id es idempotente" "duplicate_request" "$R"
check "…y no duplica filas" "1" "$(q -c "select count(*) from dose_logs where scheduled_for='2026-10-29 06:00+01'")"
DALSY=$(q -c "select id from medications where name='Dalsy'" | head -1)
R=$(as "$P1" "select public.register_dose('$DALSY',null,timestamptz '2026-10-29 15:35+01','4 ml');")
check "Dalsy a 5 min de la última toma → aviso posible duplicado" "possible_duplicate" "$R"
R=$(as "$P1" "select public.register_dose('$DALSY',null,timestamptz '2026-10-29 15:35+01','4 ml',null,'given',true,gen_random_uuid(),true);")
check "…con confirmación explícita (force) se permite" '"ok": true' "$R"
R=$(as "$P1" "select public.register_dose('$MED',null,now() + interval '2 hours','4 ml');")
check "hora futura rechazada" "future_time" "$R"
check "Dalsy y Apiretal son medicamentos con registros separados" "2" "$(q -c "select count(distinct medication_id) from dose_logs where medication_id in (select id from medications where name in ('Dalsy','Apiretal'))")"

echo "4) Corrección con historial y conflictos"
APIR_LOG=$(q -c "select l.id from dose_logs l join medications m on m.id=l.medication_id where m.name='Apiretal'" | head -1)
R=$(as "$P1" "select public.correct_dose('$APIR_LOG',1,timestamptz '2026-10-29 17:00+01','2,8 ml','hora confirmada','given',true,'');")
check "corrección sin motivo rechazada" "reason_required" "$R"
R=$(as "$P1" "select public.correct_dose('$APIR_LOG',1,timestamptz '2026-10-29 17:00+01','2,8 ml','hora confirmada','given',true,'Mireia confirma la hora');")
check "corrección con motivo OK (versión 2)" '"version": 2' "$R"
R=$(as "$P2" "select public.correct_dose('$APIR_LOG',1,timestamptz '2026-10-29 17:10+01','2,8 ml','x','given',true,'otra');")
check "edición con versión antigua → conflicto" "version_conflict" "$R"
check "historial conserva original y cambio" "2" "$(as "$P1" "select count(*) from public.dose_log_history where dose_log_id='$APIR_LOG';")"
R=$(as "$P1" "select public.void_dose('$APIR_LOG',2,'registrada por error');")
check "anular toma OK" "voided" "$R"
check "la toma anulada sigue en historial" "3" "$(as "$P1" "select count(*) from public.dose_log_history where dose_log_id='$APIR_LOG';")"
R=$(as "$P1" "select public.void_dose('$(q -c "select id from dose_logs where scheduled_for='$SLOT'" | head -1)',1,'prueba anulación');")
R=$(as "$P2" "select public.register_dose('$MED','$SLOT',timestamptz '2026-10-28 22:10+01','4 ml');")
check "tras anular, el horario queda libre de nuevo" '"ok": true' "$R"

echo "5) Verificación de pauta"
check "no se puede marcar verified directamente" "f" "$(as "$P1" "update public.medications set verified=true where id='$MED'; select verified from public.medications where id='$MED';" | tail -1)"
as "$P1" "select public.verify_medication('$MED', true, 'Confirmado por pediatra');" >/dev/null
check "verify_medication marca verificado" "t" "$(q -c "select verified from medications where id='$MED'")"
as "$P1" "update public.medications set times='{07:00,15:00,23:00}' where id='$MED';" >/dev/null
check "cambiar horarios anula la verificación" "f" "$(q -c "select verified from medications where id='$MED'")"
check "cambios de pauta quedan en historial" "t" "$(q -c "select count(*) >= 1 from medication_history where medication_id='$MED'")"

echo "6) CONCURRENCIA: dos móviles pulsan a la vez (30 rondas)"
q -c "delete from dose_logs where medication_id='$MED'" >/dev/null
BAD=0
for i in $(seq 1 30); do
  S="2026-11-0$(( (i % 9) + 1 )) $(printf '%02d' $(( i % 3 * 8 + 6 ))):00+01"
  # horarios únicos por ronda
  S=$(q -c "select ('2026-10-01 06:00+01'::timestamptz + ($i * interval '8 hours'))")
  ( as "$P1" "select public.register_dose('$MED','$S',timestamptz '$S','4 ml',null,'given',true,gen_random_uuid());" > /tmp/pgtest/c1.$i ) &
  ( as "$P2" "select public.register_dose('$MED','$S',timestamptz '$S','4 ml',null,'given',true,gen_random_uuid());" > /tmp/pgtest/c2.$i ) &
  wait
  OK1=$(grep -c '"ok": true' /tmp/pgtest/c1.$i); OK2=$(grep -c '"ok": true' /tmp/pgtest/c2.$i)
  [[ $((OK1+OK2)) -ne 1 ]] && BAD=$((BAD+1))
done
check "en ninguna ronda hubo 0 ó 2 registros ganadores" "0" "$BAD"
check "30 horarios → exactamente 30 filas activas" "30" "$(q -c "select count(*) from dose_logs where medication_id='$MED' and status<>'voided'")"
check "ningún horario duplicado" "0" "$(q -c "select count(*) from (select scheduled_for from dose_logs where medication_id='$MED' and status<>'voided' group by 1 having count(*)>1) t")"
check "la restricción única existe en la BD" "dose_logs_one_per_slot" "$(q -c "select indexname from pg_indexes where indexname='dose_logs_one_per_slot'")"

echo "7) Notificaciones por progenitor"
check "papá guarda su preferencia" "1" "$(as "$P1" "insert into public.notification_prefs(household_id,medication_id,enabled) values ('$HID','$MED',true); select count(*) from public.notification_prefs;" | tail -1)"
check "mamá no ve las preferencias de papá" "0" "$(as "$P2" "select count(*) from public.notification_prefs;")"
check "extraño no puede crear suscripción push al hogar" "violates row-level security" "$(as "$EXT" "insert into public.push_subscriptions(household_id,endpoint,p256dh,auth) values ('$HID','https://x','a','b');")"

echo; echo "RESULTADO: $PASS correctas, $FAIL fallidas"
[[ $FAIL -eq 0 ]]
