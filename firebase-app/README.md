# Aris Med — versión Firebase (la que se despliega)

Web estática (sin compilar) con Firestore + acceso con Google. Se publica en GitHub Pages desde esta carpeta.

- Acceso: solo las dos cuentas de Google de las reglas (`firestore.rules`).
- Cada toma programada se registra con una transacción de Firestore (id = medicamento + hora prevista), así dos móviles no pueden registrar la misma toma.
- Las reglas impiden borrar tomas; solo se corrigen o anulan (versión +1, con historial).
- No envía notificaciones con la app cerrada (requeriría Cloud Functions / plan Blaze). Usa una alarma del móvil para las horas concretas.
- La versión anterior con Supabase sigue en `src/` y `supabase/` (no se usa).

