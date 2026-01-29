
# Plan: Conectar los Toggles de Configuración a las Edge Functions

## Resumen Ejecutivo
Implementaremos "Kill Switches" reales en las Edge Functions críticas para que respeten la configuración guardada en la tabla `system_settings`. Actualmente, los toggles del panel de configuración son puramente visuales y no afectan el comportamiento del sistema.

## Funciones a Modificar

### 1. `automated-dunning/index.ts` - Kill Switch para Auto-Dunning
**Ubicación**: `supabase/functions/automated-dunning/index.ts`

**Cambio**: Al inicio de la función (después de crear el cliente Supabase), consultar la tabla `system_settings` buscando la key `auto_dunning_enabled`. Si el valor es `false`, detener la ejecución inmediatamente.

**Lógica**:
```text
1. Consultar: SELECT value FROM system_settings WHERE key = 'auto_dunning_enabled'
2. Si value === 'false' → retornar JSON: { skipped: true, reason: "Auto-dunning is disabled globally" }
3. Registrar en logs: "⏸️ Auto-dunning disabled globally, skipping execution"
```

---

### 2. `fetch-stripe/index.ts` - Kill Switch para Sync Pausado
**Ubicación**: `supabase/functions/fetch-stripe/index.ts`

**Cambio**: Después de la verificación de autenticación y antes de iniciar el sync, consultar `sync_paused`. Si es `true`, detener la ejecución.

**Lógica**:
```text
1. Consultar: SELECT value FROM system_settings WHERE key = 'sync_paused'
2. Si value === 'true' → retornar JSON: { success: false, status: 'skipped', reason: "Sync is paused globally" }
3. Para continuaciones automáticas (_continuation=true), también verificar el toggle
```

---

### 3. `fetch-paypal/index.ts` - Kill Switch para Sync Pausado
**Ubicación**: `supabase/functions/fetch-paypal/index.ts`

**Cambio**: Misma lógica que fetch-stripe, verificar `sync_paused` antes de iniciar.

---

### 4. `recover-revenue/index.ts` - Kill Switch para Auto-Dunning
**Ubicación**: `supabase/functions/recover-revenue/index.ts`

**Cambio**: Esta función intenta cobrar facturas automáticamente. Debe respetar `auto_dunning_enabled` ya que es parte del sistema de dunning.

---

### 5. `sync-command-center/index.ts` - Kill Switch para Sync Pausado
**Ubicación**: `supabase/functions/sync-command-center/index.ts`

**Cambio**: El orquestador maestro debe verificar `sync_paused` antes de invocar cualquier sync.

---

## Implementación Técnica

### Helper Function Reutilizable
Crearemos una función helper que puede ser copiada en cada Edge Function:

```typescript
async function getSystemSetting(
  supabase: SupabaseClient, 
  key: string
): Promise<string | null> {
  const { data } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .single();
  return data?.value ?? null;
}

async function isFeatureEnabled(
  supabase: SupabaseClient, 
  key: string, 
  defaultValue: boolean = true
): Promise<boolean> {
  const value = await getSystemSetting(supabase, key);
  if (value === null) return defaultValue;
  return value === 'true';
}
```

### Patrón de Respuesta para Funciones Deshabilitadas
Todas las funciones deshabilitadas retornarán un JSON consistente:

```json
{
  "success": true,
  "status": "skipped",
  "skipped": true,
  "reason": "Feature disabled: auto_dunning_enabled is OFF"
}
```

Esto permite que el frontend detecte que la función no falló, sino que fue omitida intencionalmente.

---

## Archivos a Modificar

| Archivo | Toggle que Respeta | Línea de Inserción |
|---------|-------------------|-------------------|
| `automated-dunning/index.ts` | `auto_dunning_enabled` | ~Línea 48 (después de crear supabase client) |
| `fetch-stripe/index.ts` | `sync_paused` | ~Línea 488 (después de crear supabase client) |
| `fetch-paypal/index.ts` | `sync_paused` | ~Línea 309 (después de crear supabase client) |
| `recover-revenue/index.ts` | `auto_dunning_enabled` | ~Línea 278 (después de crear supabase client) |
| `sync-command-center/index.ts` | `sync_paused` | ~Línea 167 (después de autenticación) |

---

## Comportamiento Esperado Post-Implementación

### Escenario: Usuario desactiva "Auto-Dunning" en el Panel
1. Toggle se guarda en `system_settings` como `auto_dunning_enabled = 'false'`
2. `automated-dunning` Edge Function es invocada (vía cron o manualmente)
3. Función consulta `system_settings` → detecta que está deshabilitada
4. Retorna `{ skipped: true, reason: "Auto-dunning is disabled globally" }`
5. No se envían mensajes de cobro automático

### Escenario: Usuario activa "Pausar Sincronización"
1. Toggle se guarda como `sync_paused = 'true'`
2. Usuario intenta sincronizar Stripe desde el UI
3. `fetch-stripe` consulta `system_settings` → detecta pausa activa
4. Retorna `{ status: 'skipped', reason: "Sync is paused globally" }`
5. UI muestra mensaje informativo en lugar de error

---

## Consideraciones de Seguridad

- Los toggles solo pueden ser modificados por usuarios autenticados con permisos de admin
- Las Edge Functions usan `SUPABASE_SERVICE_ROLE_KEY` para leer la configuración, garantizando acceso
- El patrón es "fail-open" por defecto (si no existe la configuración, se asume habilitado) para evitar bloquear funcionalidad crítica

---

## Testing Post-Implementación

1. **Test Manual**: Desactivar cada toggle y verificar que las funciones retornen `skipped: true`
2. **Test de Logs**: Verificar que los logs de Edge Functions muestren el mensaje de "Feature disabled"
3. **Test de UI**: Confirmar que el UI maneja correctamente las respuestas `skipped`
