
# Plan: Corregir Incompatibilidad RPC unify_identity

## 🚨 Problema Principal Detectado

Tu script Python envía estos parámetros:
```python
payload = {
    "p_source": platform,
    "p_ghl_contact_id": contact_id if platform == "ghl" else None,  # ❌ INCORRECTO
    "p_manychat_subscriber_id": contact_id if platform == "manychat" else None,  # ❌ INCORRECTO
    "p_email": email,
    "p_phone": phone,
    "p_full_name": full_name,
    "p_tracking_data": tracking_data or {}
}
```

Pero la función RPC en Supabase espera **orden diferente y nombres diferentes**:
```sql
unify_identity(
  p_source text,
  p_email text,                    -- 2do parámetro
  p_phone text,                    -- 3ro
  p_full_name text,                -- 4to
  p_stripe_customer_id text,       -- 5to
  p_paypal_customer_id text,       -- 6to
  p_ghl_contact_id text,           -- 7mo ← tu script lo envía como 2do
  p_manychat_subscriber_id text,   -- 8vo ← tu script lo envía como 3ro
  p_tags text[],
  p_opt_in jsonb,
  p_tracking_data jsonb
)
```

## ✅ Estado de Componentes

| Componente | Estado | Notas |
|------------|--------|-------|
| `unify_identity` RPC | ⚠️ Funciona pero parámetros incompatibles | Orden diferente al esperado |
| `match_knowledge` RPC | ✅ OK | Acepta `query_embedding`, `match_threshold`, `match_count` |
| Tabla `knowledge_base` | ✅ OK | Columna `embedding` tipo vector(1536), 163 registros |
| Índice HNSW | ⚠️ Usa IVFFlat | Funcional pero no es HNSW |
| Tabla `clients` | ✅ OK | Tiene `full_name`, `lifecycle_stage`, `total_spend`, `tags`, `last_attribution_at` |
| Tabla `chat_events` | ✅ OK | Tiene `contact_id`, `platform`, `sender`, `message`, `meta` |

---

## Solución

### Opción 1: Modificar tu Script Python (Recomendado)

Cambiar el payload para que coincida con Supabase:

```python
def identify_and_get_context(...):
    payload = {
        "p_source": platform,
        "p_email": email,
        "p_phone": phone,
        "p_full_name": full_name,
        "p_stripe_customer_id": None,
        "p_paypal_customer_id": None,
        "p_ghl_contact_id": contact_id if platform == "ghl" else None,
        "p_manychat_subscriber_id": contact_id if platform == "manychat" else None,
        "p_tags": None,
        "p_opt_in": None,
        "p_tracking_data": tracking_data or {}
    }
    identity_res = supabase.rpc("unify_identity", payload).execute()
    client_db_id = identity_res.data.get("client_id")
```

### Opción 2: Crear Wrapper RPC Compatible

Agregar una función RPC `unify_identity_v2` que acepte los parámetros en el orden que tu script envía:

```sql
CREATE OR REPLACE FUNCTION public.unify_identity_v2(
  p_source text,
  p_ghl_contact_id text DEFAULT NULL,
  p_manychat_subscriber_id text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_tracking_data jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Delegar a la función principal con el orden correcto
  RETURN unify_identity(
    p_source,
    p_email,
    p_phone,
    p_full_name,
    NULL,  -- stripe
    NULL,  -- paypal
    p_ghl_contact_id,
    p_manychat_subscriber_id,
    NULL,  -- tags
    NULL,  -- opt_in
    p_tracking_data
  );
END;
$$;
```

---

## Plan de Ejecución

### Paso 1: Crear wrapper `unify_identity_v2`
Agregar la función SQL que traduce los parámetros de tu script al formato interno.

### Paso 2: Verificar permisos RLS
Asegurar que `chat_events` permita INSERT desde el backend de Python.

### Paso 3: Testing
- Probar con un contacto de prueba desde ManyChat
- Probar con un contacto de prueba desde GHL

---

## Archivos a Modificar

| Archivo | Acción |
|---------|--------|
| Nueva migración SQL | Crear función `unify_identity_v2` |

---

## Respuesta JSON Esperada

Tu script espera:
```json
{"client_id": "uuid-aqui"}
```

La función actual retorna:
```json
{
  "success": true,
  "client_id": "uuid-aqui",
  "action": "created|updated",
  "match_by": "email|phone|ghl_contact_id|etc",
  "source": "ghl|manychat"
}
```

Tu script debería usar: `identity_res.data.get("client_id")` - Esto ya es compatible.

---

## Verificación de match_knowledge

La función está correcta:
- Acepta `query_embedding` (vector 1536)
- Acepta `match_threshold` (float) - tu script usa 0.30 ✅
- Acepta `match_count` (int) - tu script usa 5 ✅
- Retorna `id`, `content`, `similarity` ✅

La base tiene 163 documentos con embeddings listos.
