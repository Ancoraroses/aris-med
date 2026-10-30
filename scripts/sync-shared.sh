#!/usr/bin/env bash
# Copia la lógica de horarios de la app a la función de recordatorios (Deno exige extensión .ts en los imports).
set -e
cd "$(dirname "$0")/.."
sed "s#from './types'#from './types.ts'#" src/schedule.ts > supabase/functions/_shared/schedule.ts
cp src/types.ts supabase/functions/_shared/types.ts
echo "Sincronizado: supabase/functions/_shared/{schedule,types}.ts"
