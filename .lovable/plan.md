
# Plan: Corrección de Mensajes de Error y Detección de Stale

## Problema Identificado

| Issue | Causa | Solución |
|-------|-------|----------|
| Error "[object Object]" | El frontend intenta mostrar un objeto como mensaje de error | Mejorar serialización de errores |
| "Sync atascado por 30 minutos" | El campo `lastActivity` en checkpoint no se actualiza durante el background sync | Actualizar `lastActivity` en cada página procesada |

## Estado Actual del Sync

✅ **EL SYNC ESTÁ FUNCIONANDO CORRECTAMENTE**

| Métrica | Valor |
|---------|-------|
| Facturas procesadas | 30,000+ |
| Restantes | ~675 (aprox 7 páginas más) |
| Tiempo estimado para completar | ~1-2 minutos más |
| Estado | `continuing` |

**No hay bucle infinito.** Las facturas son reales y únicas (30,642 en total).

## Cambios Propuestos

### 1. Actualizar `lastActivity` en el checkpoint durante background sync

**Archivo:** `supabase/functions/fetch-invoices/index.ts`

El checkpoint actual solo tiene `cursor`, pero necesita también `lastActivity` para que el frontend no lo marque como "stale":

```typescript
// En runFullInvoiceSync(), al actualizar sync_runs:
await supabase.from('sync_runs').update({
  status: hasMore ? 'continuing' : 'completed',
  total_fetched: totalFetched,
  total_inserted: totalInserted,
  checkpoint: hasMore ? { 
    cursor,
    lastActivity: new Date().toISOString()  // ← AGREGAR
  } : null,
  completed_at: hasMore ? null : new Date().toISOString(),
}).eq('id', syncRunId);
```

### 2. Mejorar manejo de errores para evitar "[object Object]"

**Archivo:** `src/components/dashboard/APISyncPanel.tsx`

Agregar una función helper para serializar errores:

```typescript
const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    // Handle edge function error responses
    const obj = error as Record<string, unknown>;
    if (obj.message) return String(obj.message);
    if (obj.error) return String(obj.error);
    try {
      return JSON.stringify(error);
    } catch {
      return 'Error desconocido';
    }
  }
  return 'Error desconocido';
};
```

Luego usarla en todos los catch blocks:
```typescript
} catch (error) {
  const errorMessage = formatError(error);  // ← Usar nueva función
  setInvoicesResult({ success: false, error: errorMessage });
  toast.error(`Error sincronizando facturas: ${errorMessage}`);
}
```

### 3. Ajustar umbral de "stale" o usar `total_fetched` como indicador

**Archivo:** `src/components/dashboard/SyncStatusBanner.tsx`

Opción A: Usar `total_fetched` para detectar actividad real:
```typescript
// En lugar de solo lastActivity, también revisar si total_fetched cambió
const lastFetched = checkpoint?.lastFetched as number || 0;
const currentFetched = sync.total_fetched || 0;

// Si el total ha cambiado recientemente, no está stale
if (currentFetched > lastFetched) {
  activeSyncs.push(sync);
}
```

Opción B: Aumentar umbral a 60 minutos para syncs largos (facturas).

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `supabase/functions/fetch-invoices/index.ts` | Agregar `lastActivity` al checkpoint |
| `src/components/dashboard/APISyncPanel.tsx` | Función `formatError()` para errores |
| `src/components/dashboard/SyncStatusBanner.tsx` | Ajustar detección de stale |

## Impacto

- ✅ El sync actual terminará normalmente en ~1-2 minutos
- ✅ Futuros syncs no mostrarán falsos positivos de "atascado"
- ✅ Errores se mostrarán correctamente sin "[object Object]"

## Nota Importante

El sync de facturas es lento porque:
1. Stripe devuelve datos densos por factura
2. Cada factura requiere resolución de cliente (lookup por ID + email)
3. El upsert es más costoso que un insert simple

Una optimización futura podría ser cachear el mapeo `stripe_customer_id → client_id` en memoria durante el batch.
