
# Plan: Arreglar Todos los Problemas de Seguridad

## Resumen de Problemas Detectados

| Problema | Severidad | Causa |
|----------|-----------|-------|
| Email admin hardcodeado | ALTO | `ADMIN_EMAIL = "djkubo@live.com.mx"` en Login.tsx |
| Políticas RLS "Always True" | ALTO | 2 tablas con acceso público |
| Functions sin search_path | MEDIO | 8 funciones vulnerables a inyección de esquema |
| Vistas materializadas expuestas | BAJO | 2 vistas accesibles via API |
| Extension en public | BAJO | `vector` instalada en public schema |
| Leaked Password Protection | BAJO | Deshabilitado en config de auth |

---

## Fase 1: Eliminar Email Hardcodeado (CRÍTICO)

### Cambio en `src/pages/Login.tsx`

Eliminar la validación client-side del email admin. La seguridad real ya está implementada server-side en la tabla `app_admins` y la función `is_admin()`.

**Antes:**
```typescript
const ADMIN_EMAIL = "djkubo@live.com.mx";

// Check if email is admin
if (email.toLowerCase().trim() !== ADMIN_EMAIL.toLowerCase()) {
  toast({ title: "Acceso denegado", ... });
  return;
}
```

**Después:**
- Eliminar la constante `ADMIN_EMAIL`
- Eliminar el bloque de validación client-side
- Dejar que Supabase Auth maneje la autenticación
- Las RLS policies con `is_admin()` protegen los datos server-side

Esto es correcto porque:
1. La autenticación real es via Supabase Auth (email + password)
2. El acceso a datos está protegido por RLS + `is_admin()`
3. El check client-side solo expone el email admin y da falsa seguridad

---

## Fase 2: Arreglar Políticas RLS Permisivas

### Tabla: `payment_update_links`

La política actual permite a cualquiera ver todos los tokens de pago:
```sql
-- PROBLEMA: "Public can validate own token" con qual=true
```

**Solución:** Cambiar para que solo permita validar un token específico pasado como parámetro, no listar todos:

```sql
DROP POLICY IF EXISTS "Public can validate own token" ON public.payment_update_links;

-- Nueva política: Solo permite SELECT cuando se proporciona un token específico
CREATE POLICY "Validate specific token only" ON public.payment_update_links
  FOR SELECT TO anon
  USING (
    -- Solo permite leer si el request viene con el token correcto
    -- Esto se valida en el edge function, no expone lista completa
    false
  );

-- Admin puede ver todo
CREATE POLICY "Admin full access payment_update_links" ON public.payment_update_links
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Service role para edge functions
CREATE POLICY "Service role payment_update_links" ON public.payment_update_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### Tabla: `scheduled_messages`

```sql
DROP POLICY IF EXISTS "Anyone can view scheduled messages" ON public.scheduled_messages;

CREATE POLICY "Admin can manage scheduled_messages" ON public.scheduled_messages
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Service role scheduled_messages" ON public.scheduled_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

---

## Fase 3: Arreglar Funciones sin search_path

Las siguientes funciones necesitan `SET search_path = public`:

1. `cleanup_old_financial_data`
2. `get_staging_counts_accurate` 
3. `kpi_invoices_at_risk`
4. `kpi_invoices_summary`
5. `kpi_mrr_summary`
6. `refresh_lifecycle_counts`
7. `update_recovery_queue_updated_at`
8. `update_updated_at_column`

Para cada función, se ejecutará:
```sql
ALTER FUNCTION public.function_name() SET search_path = public;
```

Esto previene ataques de inyección de esquema donde un atacante podría crear funciones maliciosas con el mismo nombre en un esquema diferente.

---

## Fase 4: Proteger Vistas Materializadas

Las vistas `mv_client_lifecycle_counts` y `mv_sales_summary` están expuestas via API.

**Solución:** Revocar acceso anónimo:

```sql
REVOKE ALL ON public.mv_client_lifecycle_counts FROM anon;
REVOKE ALL ON public.mv_sales_summary FROM anon;
GRANT SELECT ON public.mv_client_lifecycle_counts TO authenticated;
GRANT SELECT ON public.mv_sales_summary TO authenticated;
```

---

## Fase 5: Mover Extension a Schema Dedicado

La extensión `vector` está en `public`. Moverla a un schema dedicado:

```sql
-- Crear schema para extensiones
CREATE SCHEMA IF NOT EXISTS extensions;

-- Nota: Mover la extensión vector requiere recrearla
-- lo cual puede ser disruptivo. Una alternativa es ignorar
-- este warning ya que el riesgo es menor.
```

**Decisión:** Ignorar este warning. Mover `vector` requeriría recrear todos los índices vectoriales y es un cambio de alto riesgo para un beneficio menor. El warning es informativo.

---

## Fase 6: Habilitar Leaked Password Protection

Usar la herramienta de configuración de auth para habilitar la protección contra contraseñas filtradas.

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/pages/Login.tsx` | Eliminar ADMIN_EMAIL y validación client-side |
| Nueva migración SQL | Arreglar RLS, functions, y vistas |

---

## Orden de Implementación

1. Crear migración SQL para:
   - Arreglar políticas de `payment_update_links`
   - Arreglar políticas de `scheduled_messages`
   - Agregar search_path a 8 funciones
   - Revocar acceso a vistas materializadas

2. Modificar `Login.tsx` eliminando email hardcodeado

3. Habilitar Leaked Password Protection via auth config

4. Marcar hallazgos de seguridad como resueltos

---

## Verificación Post-Implementación

Después de aplicar los cambios:
- El escaneo de seguridad debe mostrar 0 errores críticos
- Los warnings restantes serán:
  - Extension in Public (ignorado intencionalmente)
  - Service role policies (aceptables para edge functions)

