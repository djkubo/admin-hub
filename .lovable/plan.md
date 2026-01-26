
# Plan: Corrección Integral del Sistema de Sincronización

## Diagnóstico Completo

### Problema 1: Race Condition en `fetch-stripe`
El sync en background (`EdgeRuntime.waitUntil`) termina correctamente y actualiza el status a `completed`, pero hay un intervalo de tiempo donde un nuevo sync puede detectar el registro como `running` antes de que se actualice.

### Problema 2: Auto-limpieza no funciona correctamente
La auto-limpieza de 15 minutos solo limpia syncs de **más de 15 minutos**, pero los syncs que terminan en segundos dejan el registro en `running` brevemente. Si hay una race condition, el nuevo sync detecta el viejo como activo.

### Problema 3: GHL sync atascado
Hay un sync de GHL con status `continuing` que lleva **40+ minutos** corriendo, bloqueando potencialmente el flujo.

### Problema 4: `sync-command-center` no limpia syncs de otras fuentes
Cuando el command center detecta un error 409 en Stripe, solo lo registra pero no ofrece limpieza automática para todos los syncs.

### Problema 5: No hay limpieza unificada al inicio del sync
Cada edge function limpia solo sus propios syncs, pero no hay una limpieza general antes de empezar.

---

## Solución Propuesta

### Cambio 1: Agregar limpieza global de syncs atascados en `sync-command-center`
Al inicio del sync, limpiar TODOS los syncs atascados (de cualquier fuente) mayores a 10 minutos.

**Archivo**: `supabase/functions/sync-command-center/index.ts`
```typescript
// Al inicio, antes de crear el sync run
const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
await dbClient
  .from('sync_runs')
  .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: 'Timeout - auto-cleanup' })
  .in('status', ['running', 'continuing'])
  .lt('started_at', staleThreshold);
```

### Cambio 2: Reducir umbral de limpieza a 10 minutos en `fetch-stripe`
15 minutos sigue siendo demasiado para syncs cortos.

**Archivo**: `supabase/functions/fetch-stripe/index.ts`
- Línea ~607: Cambiar `15 * 60 * 1000` → `10 * 60 * 1000`

### Cambio 3: Agregar `forceCancel` para todas las fuentes en `sync-command-center`
Permitir cancelar todos los syncs activos desde el command center.

**Archivo**: `supabase/functions/sync-command-center/index.ts`
```typescript
// Nuevo handler al inicio
if (body.forceCancel) {
  const { data } = await dbClient
    .from('sync_runs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .in('status', ['running', 'continuing'])
    .select('id, source');
  return Response.json({ success: true, cancelled: data?.length || 0 });
}
```

### Cambio 4: Mejorar `handleForceCancel` en frontend para cancelar TODOS los syncs
Actualmente solo cancela Stripe. Debe cancelar todos.

**Archivo**: `src/components/dashboard/DashboardHome.tsx`
```typescript
const handleForceCancel = async () => {
  setSyncProgress('Cancelando syncs...');
  // Cancelar syncs de todas las fuentes
  await Promise.allSettled([
    invokeWithAdminKey('fetch-stripe', { forceCancel: true }),
    invokeWithAdminKey('fetch-paypal', { forceCancel: true }),
    invokeWithAdminKey('sync-ghl', { forceCancel: true }),
    invokeWithAdminKey('sync-manychat', { forceCancel: true }),
  ]);
  toast.success('Todos los syncs cancelados');
  // ...
};
```

### Cambio 5: Agregar `forceCancel` a `sync-ghl` y `sync-manychat`
Estas edge functions no tienen el parámetro `forceCancel` implementado.

**Archivos**: 
- `supabase/functions/sync-ghl/index.ts`
- `supabase/functions/sync-manychat/index.ts`

```typescript
// Al inicio del handler
if (body.forceCancel) {
  const { data } = await supabase
    .from('sync_runs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('source', 'ghl') // o 'manychat'
    .in('status', ['running', 'continuing'])
    .select('id');
  return Response.json({ ok: true, cancelled: data?.length });
}
```

### Cambio 6: Añadir botón global "Limpiar Syncs Atascados" en SyncResultsPanel
Un botón que cancele todos los syncs de todas las fuentes de una sola vez.

**Archivo**: `src/components/dashboard/SyncResultsPanel.tsx`
- Modificar `handleCancelSync` para aceptar 'all' como parámetro
- Cuando sea 'all', llamar a todas las edge functions con `forceCancel: true`

---

## Archivos a Modificar

1. `supabase/functions/sync-command-center/index.ts` - Limpieza global al inicio + `forceCancel` handler
2. `supabase/functions/fetch-stripe/index.ts` - Reducir umbral a 10 min
3. `supabase/functions/sync-ghl/index.ts` - Agregar `forceCancel`
4. `supabase/functions/sync-manychat/index.ts` - Agregar `forceCancel`
5. `src/components/dashboard/DashboardHome.tsx` - Mejorar `handleForceCancel`
6. `src/components/dashboard/SyncResultsPanel.tsx` - Botón "Cancelar Todo" global

---

## Acciones Inmediatas Post-Implementación

Después de implementar, ejecutar para limpiar el sync de GHL atascado:
```sql
UPDATE sync_runs 
SET status = 'cancelled', completed_at = NOW(), error_message = 'Cancelado - sync atascado' 
WHERE status IN ('running', 'continuing');
```

---

## Beneficios

1. **Auto-reparación**: Los syncs se auto-limpian más agresivamente (10 min)
2. **Limpieza global**: Un botón para cancelar TODO
3. **Sin bloqueos cruzados**: El command center limpia syncs de todas las fuentes
4. **Consistencia**: Todas las edge functions responden a `forceCancel`
5. **UX mejorada**: El usuario puede resolver cualquier bloqueo desde la UI

---

## Sección Técnica

### Race Condition Explicada
```text
Timeline del problema:
T0: fetch-stripe crea sync_run con status='running'
T1: EdgeRuntime.waitUntil inicia el proceso en background
T2: Frontend recibe respuesta "success, running in background"
T3: Usuario hace click en "Sync All" de nuevo (o el command-center llama)
T4: Nueva llamada a fetch-stripe detecta sync_run con status='running' → 409
T5: El proceso de T1 termina y actualiza status='completed'
```

La solución reduce T4 verificando si el sync tiene más de 10 minutos, y permite cancelar manualmente si ocurre el 409.

### Flujo de Cancelación Mejorado
```text
1. Usuario ve error 409 → Toast con botón "Cancelar y reiniciar"
2. handleForceCancel() llama a TODAS las edge functions con forceCancel: true
3. Cada edge function cancela sus propios syncs
4. Frontend espera 1 segundo
5. handleSyncAll() reinicia el proceso limpio
```
