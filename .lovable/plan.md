

# Plan: Crear Edge Function "vrp-brain-api"

## Objetivo
Crear un API Gateway seguro para conectar tu agente Python externo con las funciones de Supabase.

---

## Estructura de la Función

```text
supabase/functions/
└── vrp-brain-api/
    └── index.ts       ← Nueva función
```

---

## Especificaciones Técnicas

### 1. Seguridad
| Header | Valor Esperado |
|--------|----------------|
| `x-admin-key` | `vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk` |

Si no coincide → Retorna `401 Unauthorized`

### 2. Acciones Soportadas

| Action | Operación | Parámetros Body |
|--------|-----------|-----------------|
| `identify` | `supabase.rpc('unify_identity_v2', params)` | Todos los `p_*` de la función |
| `search` | `supabase.rpc('match_knowledge', params)` | `query_embedding`, `match_threshold`, `match_count` |
| `insert` | `supabase.from(table).insert(data)` | `table`, `data` |

### 3. CORS
Headers completos para permitir conexiones externas desde cualquier origen.

---

## Código de la Función

```typescript
// supabase/functions/vrp-brain-api/index.ts

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ADMIN_KEY = 'vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk'

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const requestId = crypto.randomUUID().slice(0, 8)
  console.log(`[${requestId}] vrp-brain-api: Start`)

  try {
    // ========== SECURITY CHECK ==========
    const providedKey = req.headers.get('x-admin-key')
    if (providedKey !== ADMIN_KEY) {
      console.warn(`[${requestId}] Unauthorized - Invalid key`)
      return new Response(
        JSON.stringify({ ok: false, error: 'Unauthorized', message: 'Invalid x-admin-key' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ========== PARSE BODY ==========
    const body = await req.json()
    const { action, ...params } = body

    if (!action) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing action field' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let result: any
    let error: any

    // ========== ACTION ROUTER ==========
    switch (action) {
      case 'identify':
        console.log(`[${requestId}] Action: identify`)
        const identifyResult = await supabase.rpc('unify_identity_v2', params)
        result = identifyResult.data
        error = identifyResult.error
        break

      case 'search':
        console.log(`[${requestId}] Action: search`)
        const searchResult = await supabase.rpc('match_knowledge', params)
        result = searchResult.data
        error = searchResult.error
        break

      case 'insert':
        console.log(`[${requestId}] Action: insert → ${params.table}`)
        if (!params.table || !params.data) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Insert requires "table" and "data" fields' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        const insertResult = await supabase.from(params.table).insert(params.data).select()
        result = insertResult.data
        error = insertResult.error
        break

      default:
        return new Response(
          JSON.stringify({ ok: false, error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }

    if (error) {
      console.error(`[${requestId}] Error:`, error)
      return new Response(
        JSON.stringify({ ok: false, error: error.message, details: error }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[${requestId}] Success`)
    return new Response(
      JSON.stringify({ ok: true, data: result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error'
    console.error(`[${requestId}] Fatal:`, err)
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

---

## Configuración config.toml

Agregar al final de `supabase/config.toml`:

```toml
[functions.vrp-brain-api]
verify_jwt = false
```

---

## Ejemplos de Uso (Python)

### Identify
```python
import requests

url = "https://sbexeqqizazjfsbsgrbd.supabase.co/functions/v1/vrp-brain-api"
headers = {"x-admin-key": "vrp_admin_2026_K8p3dQ7xN2v9Lm5R1s0T4u6Yh8Gf3Jk"}

response = requests.post(url, json={
    "action": "identify",
    "p_source": "python_agent",
    "p_email": "cliente@ejemplo.com",
    "p_phone": "+5215512345678",
    "p_full_name": "Juan Pérez"
}, headers=headers)

print(response.json())
```

### Search (Knowledge Base)
```python
response = requests.post(url, json={
    "action": "search",
    "query_embedding": [0.1, 0.2, ...],  # Vector de embedding
    "match_threshold": 0.7,
    "match_count": 5
}, headers=headers)
```

### Insert
```python
response = requests.post(url, json={
    "action": "insert",
    "table": "chat_logs",
    "data": {
        "client_id": "uuid-aqui",
        "message": "Hola, tengo una duda",
        "role": "user"
    }
}, headers=headers)
```

---

## Archivos a Crear/Modificar

| Archivo | Acción |
|---------|--------|
| `supabase/functions/vrp-brain-api/index.ts` | **Crear** - Código principal |
| `supabase/config.toml` | **Modificar** - Agregar configuración |

---

## Despliegue
La función se desplegará automáticamente cuando se guarden los cambios.

