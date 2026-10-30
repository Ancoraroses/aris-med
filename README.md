# Aris Med

Registro familiar compartido de medicación para dos progenitores (PWA en español).
**Herramienta de registro: no es un sistema de prescripción ni sustituye al pediatra.** La app no calcula ni cambia dosis (tampoco según el peso), no modifica frecuencias, no compensa dosis omitidas y no alterna Dalsy/Apiretal.

- **Frontend:** React + TypeScript + Vite, PWA (manifest, iconos, service worker, push).
- **Backend:** Supabase (Postgres + Auth + Realtime + Edge Functions). Coste: el plan gratuito basta para una familia.
- **Por qué Supabase:** las restricciones únicas, las reglas de acceso (RLS) y las funciones SQL transaccionales evitan duplicados aunque dos móviles pulsen a la vez, y el tiempo real sincroniza ambos teléfonos sin exportar/importar nada.

---

## 1. Estructura del proyecto

```
aris-med/
├─ src/
│  ├─ schedule.ts          Lógica pura: zonas horarias, horarios previstos, intervalos, días de tratamiento
│  ├─ store.tsx            Estado, sincronización, tiempo real, cola sin conexión, acciones
│  ├─ App.tsx · Auth.tsx   Navegación, login, crear/unirse a hogar
│  ├─ Home.tsx             Pantalla principal (avisos, próximas tomas, medicamentos, última actividad)
│  ├─ RegisterSheet.tsx    «Registrar toma» + confirmación
│  ├─ History.tsx          Historial, filtros, correcciones, incidencias, exportación CSV/PDF
│  ├─ Meds.tsx             Pautas, horarios editables, verificación con profesional
│  ├─ Settings.tsx         Perfil, invitación, recordatorios por medicamento, instalación
│  ├─ sw.ts                Service worker (carcasa offline + notificaciones push)
│  └─ *.test.ts(x)         Pruebas unitarias y de interfaz
├─ public/                 Iconos PWA
├─ supabase/
│  ├─ migrations/          Esquema, funciones RPC, reglas RLS (3 archivos, en orden)
│  ├─ functions/send-reminders/   Edge Function de recordatorios push
│  ├─ functions/_shared/   Copia de schedule.ts (se regenera con scripts/sync-shared.sh)
│  ├─ tests/               Pruebas de BD (acceso, duplicados, concurrencia…)
│  └─ cron.sql.example     Programación del envío de recordatorios
├─ .env.example · .github/workflows/deploy.yml · scripts/sync-shared.sh
```

## 2. Qué credenciales y configuración necesitas crear

Nada de esto está en el código; **tú** lo creas y lo pones donde se indica.

| Qué | Dónde se obtiene | Dónde se usa | ¿Es secreto? |
|---|---|---|---|
| Proyecto Supabase | supabase.com → New project (región UE) | — | — |
| `Project URL` y `anon key` | Supabase → Project Settings → API | `.env.local` / secretos de GitHub (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) | No: la anon key es pública; la seguridad la dan las reglas RLS |
| `service_role key` | (la inyecta Supabase en la función) | **Nunca** en la app ni en GitHub | **Sí, no la copies a ningún sitio** |
| Claves VAPID (push) | `npx web-push generate-vapid-keys` en tu ordenador | Pública → `VITE_VAPID_PUBLIC_KEY`; privada → `supabase secrets set` | La privada **sí** |
| `CRON_SECRET` | Invéntalo tú (cadena larga aleatoria) | `supabase secrets set` y `cron.sql` | **Sí** |

Las contraseñas de cada progenitor las escribe cada uno en la pantalla de acceso; nunca van en el código.

## 3. Configurar Supabase (paso a paso)

1. Crea el proyecto en Supabase.
2. **SQL Editor →** pega y ejecuta, **en este orden**, los tres archivos de `supabase/migrations/` (`…001_schema.sql`, `…002_functions.sql`, `…003_policies.sql`). Deben terminar sin errores.
   *(Alternativa con la CLI: `supabase link` + `supabase db push`.)*
3. **Authentication → Providers → Email:** activado. Recomendado: «Confirm email» activado (cada uno confirma su correo una vez).
4. **Authentication → URL Configuration:** *Site URL* = la URL final de la app (paso 5). Añade la misma en *Redirect URLs*.
5. Copia `.env.example` a `.env.local`, rellena `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
6. `npm install && npm run dev` para probar en local (o salta al despliegue).

### Seguridad de datos (resumen de lo que hay en la BD)
- RLS activada en todas las tablas; solo los **miembros del hogar** leen/modifican. Los usuarios anónimos no tienen acceso a nada.
- **Las tomas, correcciones, anulaciones, incidencias e invitaciones solo se escriben mediante funciones** (`register_dose`, `correct_dose`, `void_dose`, `register_incident`, `create_invitation`, `accept_invitation`); el cliente no puede insertar/modificar/borrar tomas directamente.
- **Duplicados:** índice único parcial `(medication_id, scheduled_for)` para tomas activas + bloqueo asesor por medicamento dentro de la transacción + `client_op_id` único (reintentos idempotentes).
- Cada corrección o anulación guarda la versión anterior (`dose_log_history`); los cambios de pauta quedan en `medication_history`.
- Cambiar una pauta/horario **anula automáticamente su verificación**, y sin verificación no se envían recordatorios.
- Invitaciones: código de 10 caracteres, un solo uso, caduca en 7 días, el hogar admite como máximo 2 personas.

## 4. Desplegar con HTTPS

HTTPS es obligatorio para PWA y push. Opciones gratuitas con HTTPS incluido:

**A) GitHub Pages (ya incluido el workflow `.github/workflows/deploy.yml`)**
1. Sube el proyecto a un repositorio **privado o público** (el repo no contiene secretos).
2. Repo → Settings → Secrets and variables → Actions → *New repository secret*: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`.
3. Repo → Settings → Pages → Source: **GitHub Actions**. Haz push a `main`; el workflow compila y publica.
4. La URL será `https://TU-USUARIO.github.io/NOMBRE-REPO/`. Ponla en Supabase (paso 3.4).

**B) Netlify / Cloudflare Pages / Vercel:** conecta el repo, comando `npm run build`, carpeta `dist`, y define las 3 variables `VITE_…` en el panel.

> Si cambias las variables, hay que volver a compilar/desplegar: se incrustan en el build.

## 5. Recordatorios push (opcional, hazlo DESPUÉS de verificar las pautas)

1. `npx web-push generate-vapid-keys` → guarda las dos claves.
2. Pon la clave **pública** en `VITE_VAPID_PUBLIC_KEY` y vuelve a desplegar la app.
3. Con la CLI de Supabase (`npm i -g supabase`, `supabase login`, `supabase link --project-ref TU_REF`):
   ```
   supabase secrets set CRON_SECRET=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tu@correo
   supabase functions deploy send-reminders --no-verify-jwt
   ```
4. Activa las extensiones `pg_cron` y `pg_net` (Database → Extensions) y ejecuta `supabase/cron.sql.example` **con tus valores** en el SQL Editor.
5. En cada móvil: Ajustes → «Activar notificaciones en este teléfono» y, por cada medicamento verificado, activa el recordatorio (cada progenitor elige el suyo, con aviso previo y aviso si no se registra).

**Reglas del envío:** solo medicamentos activos, de horario fijo y verificados; solo a quien activó ese recordatorio; no se avisa si la toma ya está registrada (administrada, omitida o pendiente de confirmar); no se repite un mismo aviso (tabla `reminder_log`); la notificación de una misma toma se sustituye en el móvil en lugar de acumularse.

### Limitaciones reales en Android (léelas)
- Necesita permiso de notificaciones y que el sitio no esté bloqueado en Chrome.
- Con la app **cerrada**, el aviso lo entrega el servicio push de Google; suele llegar, pero Android puede **retrasarlo o descartarlo** (ahorro de batería, «No molestar», datos en segundo plano restringidos, «forzar cierre» de Chrome).
- **No es una alarma garantizada.** Para dosis críticas, usa además una alarma del reloj del móvil.
- Un push no puede mostrar «administrada» en tiempo real al otro progenitor: lo comprueba el servidor al enviar; si se registra un segundo después, el aviso ya habrá salido.
- El horario 22:00/06:00/14:00 es una **propuesta**; los recordatorios no funcionan hasta que se marque como verificado.

## 6. Instalar en ambos teléfonos
1. Abre la URL en **Chrome para Android**.
2. Menú ⋮ → **Instalar aplicación** (o «Añadir a pantalla de inicio»), o pulsa «Instalar» en Ajustes si aparece.
3. Crea tu cuenta. Quien empieza pulsa **Crear hogar** (se cargan los datos de la receta del 29/10/2026).
4. En Ajustes → **Invitar al otro progenitor**: se genera un código y un enlace (WhatsApp). Mireia abre el enlace, crea su cuenta e introduce su nombre → queda unida al hogar.
5. Ambos verán las mismas tomas en tiempo real y quién registró cada una.

## 7. Pruebas realizadas (y cómo repetirlas)

Ejecutadas en este entorno el 29/10/2026:

| Prueba | Resultado | Comando |
|---|---|---|
| **BD: 48 comprobaciones** (hogar/invitaciones, RLS, duplicados, correcciones con historial, verificación, **30 rondas de concurrencia con dos sesiones simultáneas**, preferencias por usuario) | 48/48 ✔ | `supabase/tests/run_tests.sh` |
| Lógica de horarios (zona horaria Madrid, 22:00/06:00/14:00, intervalos, 10 días = 30 tomas, cambio de hora, estados) | 22/22 ✔ | `npm test` |
| Interfaz con cliente Supabase **simulado** (avisos, confirmación previa, conflicto de toma ya registrada, cola sin conexión que NO se muestra como administrada, aviso de intervalo corto) | 6/6 ✔ | `npm test` |
| TypeScript estricto + compilación de producción + service worker con handler push | ✔ | `npm run build` |

**Registro simultáneo de una misma dosis (prueba 6 de la BD):** en 30 rondas, dos sesiones (papá y mamá) llaman a `register_dose` para la misma toma a la vez; en **ninguna** ronda hubo 0 ni 2 registros ganadores y quedan exactamente 30 filas activas, sin horarios duplicados.

Cómo repetir las pruebas de BD: necesitan un PostgreSQL local (se probó con 16) con el stub `supabase/tests/00_supabase_stub.sql` (imita roles y `auth.uid()`; **no** se ejecuta en Supabase real), luego los 3 archivos de migración y `PGHOST=… PGPORT=… PGUSER=postgres PGDATABASE=… ./run_tests.sh`.

### Pruebas manuales recomendadas con dos móviles reales (no he podido hacerlas)
1. **Sincronización:** registra una toma en el móvil A → debe aparecer en B en pocos segundos con tu nombre.
2. **Simultaneidad:** en ambos móviles abre «Registrar» de la misma toma y confirma casi a la vez → uno la registra; el otro ve «Esta toma ya estaba registrada».
3. **Persistencia:** cierra y reabre la app → sigue la sesión y los datos.
4. **Sin conexión:** modo avión, registra → aviso «guardada solo en este teléfono», no figura como administrada; al reconectar se envía sola sin duplicar.
5. **Acceso:** con una cuenta ajena (sin invitación) no se ve ningún dato (ya probado en BD).
6. **Push:** tras verificar y activar un recordatorio, comprueba que llega el aviso previo y que no llega si ya está registrada.

## 8. Qué incluye cada pantalla
- **Inicio:** niña, fecha y hora, avisos (pauta sin verificar, hora por confirmar, tomas sin registrar, intervalos incorrectos, cola sin sincronizar), próximas tomas con estado (pendiente/administrada/omitida/pendiente de confirmar/retrasada), lista de medicamentos con día de tratamiento y última toma, última actividad, botón «Registrar toma».
- **Registrar toma:** medicamento, dosis de la pauta, horario previsto vs hora real, persona, observaciones → pantalla de confirmación con avisos (intervalo, desviación, duplicado) → «administrada» solo cuando el servidor lo confirma.
- **Historial:** filtros por fechas, medicamento y estado; detalle con historial de modificaciones; corregir/anular con motivo obligatorio; incidencias (vómito, rechazo, reacción…); **exportar CSV** (se comparte desde el móvil) e imprimir/PDF.
- **Pautas:** datos de la receta editables, horas editables con intervalos reales calculados y avisos, fecha de inicio y duración (no se prolonga sola), verificación con el profesional.
- **Ajustes:** perfil, invitación, recordatorios por medicamento y por progenitor, instalación.

### Datos iniciales cargados (receta 29/10/2026, **a verificar**)
Augmentine 4 ml/8 h/10 d · Bactroban nasal 1 aplicación/8 h/7 d (ambos con horario propuesto 22:00-06:00-14:00, inicio 29/10 22:00) · Dalsy 4 ml/8 h/3 d (última toma conocida 15:30 del 29/10) · Apiretal 2,8 ml/6 h/3 d (administrado el 29/10, **hora por confirmar**) · Ultra-Levura 1 sobre/24 h/10 d. Dalsy, Apiretal y Ultra-Levura quedan en **registro manual** (no se les inventa horario). Peso 19 kg guardado solo como dato informativo.

## 9. Limitaciones conocidas
- **No probado con Supabase real ni con móviles reales** (no tengo tus credenciales ni dispositivos): sincronización en tiempo real, envío de push, instalación PWA y la Edge Function están escritos pero **sin ejecutar de extremo a extremo**. La lógica SQL sí se probó en PostgreSQL 16 con un simulacro de Supabase; la interfaz con un cliente simulado.
- Los avisos push no son una alarma garantizada (ver arriba). La Edge Function usa `web-push` en Deno; si falla el despliegue, revisa los logs de la función.
- Si dos personas editan a la vez un registro, la segunda recibe «conflicto de versión» y debe revisar (no se sobrescribe en silencio).
- Los recordatorios solo existen para medicamentos de **horario fijo**; los de registro manual (Dalsy, Apiretal, Ultra-Levura) muestran el intervalo de la receta como información, sin avisar.
- Un usuario pertenece a un solo hogar; el hogar admite 2 personas (campo `max_members`).
- Si se cierra el tratamiento, la app avisa pero no «cierra» sola el medicamento: se desactiva a mano.
- El service worker solo cachea la carcasa de la app; **abrir sin conexión no muestra datos** (se muestra el estado de «sin conexión» y los registros nuevos se guardan en cola).
- Sin protección contra fuerza bruta específica en el código de invitación (40 bits, 7 días, un solo uso, requiere cuenta); Supabase aplica sus límites de tasa estándar.
- Tolerancia de intervalo fija en ±15 min y margen de «retrasada» en 30 min (constantes en `schedule.ts`).
- La app es un apoyo al registro: **ante cualquier duda de dosis, horario o síntomas, consulta al pediatra o a la farmacia.**
