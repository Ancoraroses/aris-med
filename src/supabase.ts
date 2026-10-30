import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** true solo si hay una base de datos configurada. Si es false, la app NO simula sincronización. */
export const configured = Boolean(url && anon && !url.includes('TU-PROYECTO') && !anon.includes('TU_CLAVE'))

// Solo se usa la clave ANON (pública). La seguridad la aplican las reglas RLS de la base de datos.
export const supabase = createClient(configured ? url! : 'https://not-configured.invalid', configured ? anon! : 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
})

export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || ''
