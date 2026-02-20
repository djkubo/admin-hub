# Admin Hub CRM

Panel operativo para CRM, analytics, mensajería y revenue ops con React + Supabase.

## Inicio Rápido
1. Instala dependencias: `npm install`
2. Configura variables: copia `.env.example` a `.env.local` y ajusta secretos.
3. Levanta el frontend: `npm run dev`
4. Corre validaciones base antes de push:
- `npm run test`
- `npm run build`

## Stack
- Frontend: React 18 + Vite + TypeScript + Tailwind + shadcn/ui
- Estado de datos: TanStack Query
- Backend: Supabase (Postgres + Edge Functions)
- Tests: Vitest

## Mapa del Repositorio
- `src/App.tsx`: router principal y composición global de providers.
- `src/config/appPaths.ts`: rutas canónicas y redirects legacy.
- `src/components/dashboard/*`: páginas y widgets del panel.
- `src/hooks/*`: acceso a datos, mutaciones y lógica de negocio en frontend.
- `src/lib/*`: utilidades transversales (API admin, parsing CSV, auth helpers).
- `supabase/functions/*`: Edge Functions por dominio.
- `supabase/migrations/*`: historial de migraciones SQL.
- `docs/*`: runbooks y notas operativas.

## Áreas Funcionales (UI)
- Insights: `/insights/analytics`
- CRM: `/crm/clients`, `/crm/inbox`
- Growth: `/growth/campaigns`, `/growth/broadcast`, `/growth/flows`
- Channels: `/channels/whatsapp`
- Revenue: `/revenue/transactions`, `/revenue/invoices`, `/revenue/subscriptions`, `/revenue/recovery`
- Ops/Admin: `/ops/sync`, `/ops/diagnostics`, `/admin/settings`

## Flujo de Desarrollo Recomendado
1. Crea una rama corta por cambio.
2. Implementa cambios en frontend + función/migración si aplica.
3. Valida localmente:
- `npm run test`
- `npm run build`
- `npx tsc --noEmit`
4. Si tocaste Edge Function, valida también con Deno:
- `deno check supabase/functions/<funcion>/index.ts`
5. Haz commit con alcance pequeño y mensaje claro.
6. Push a `main` solo cuando el lote esté validado (si tu integración de deploy usa `main`, esto impacta producción).

## Convenciones Importantes
- No editar rutas hardcodeadas: usa `APP_PATHS` en `src/config/appPaths.ts`.
- No asumir contrato de Edge Functions sin revisar la respuesta real (`ok`/`success`, payload, status).
- Migraciones SQL: agregar nuevas, evitar reescribir historial existente salvo urgencia controlada.

## Documentación
Ver índice en `docs/README.md`.
