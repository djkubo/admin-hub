
# Plan: Optimización de Sincronización PayPal con Paginación Correcta

## Diagnóstico

| Problema | Impacto |
|----------|---------|
| Frontend no continúa páginas internas de PayPal | Solo 1 de cada 9-21 páginas se procesa |
| Contadores se sobrescriben en lugar de sumar | Métricas de progreso incorrectas |
| Sin loop `while(hasMore)` como el de facturas Stripe | Datos incompletos (~10% real) |

**Estado actual**: 38,502 transacciones PayPal, pero probablemente faltan decenas de miles.

---

## Solución: Paginación de PayPal al Estilo Facturas

### 1. Frontend - APISyncPanel.tsx

Agregar loop de paginación interno para PayPal (como el de facturas):

```text
syncPayPal() {
  for (cada chunk de 31 días) {
    syncRunId = null
    hasMore = true
    page = 1
    
    while (hasMore) {
      response = fetch-paypal({ 
        syncRunId, 
        page, 
        startDate, 
        endDate 
      })
      
      syncRunId = response.syncRunId
      hasMore = response.hasMore
      page = response.nextPage
      
      acumulador += response.synced_transactions
      
      await delay(200ms)  // Rate limit
    }
  }
}
```

### 2. Backend - fetch-paypal/index.ts

Arreglar contadores incrementales (como fetch-invoices):

```text
Antes:
  total_fetched: transactionsSaved

Después:
  const { data: currentRun } = await supabase
    .from('sync_runs')
    .select('total_fetched, total_inserted')
    .eq('id', syncRunId)
    .single();
    
  total_fetched: (currentRun?.total_fetched || 0) + transactionsSaved
  total_inserted: (currentRun?.total_inserted || 0) + transactionsSaved
```

### 3. Limpiar Syncs Bloqueados

Cancelar cualquier sync de PayPal en estado `running` o `continuing`:

```sql
UPDATE sync_runs 
SET status = 'cancelled', 
    completed_at = NOW(),
    error_message = 'Limpieza - optimización paginación'
WHERE source = 'paypal' 
AND status IN ('running', 'continuing');
```

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/components/dashboard/APISyncPanel.tsx` | Agregar loop `while(hasMore)` para PayPal |
| `supabase/functions/fetch-paypal/index.ts` | Contadores incrementales + bypass "sync already running" si tiene syncRunId |

---

## Flujo Optimizado

```text
┌─────────────────────────────────────────────────────────────┐
│                      Frontend Loop                          │
├─────────────────────────────────────────────────────────────┤
│  Chunk 1: Enero 2026                                        │
│    ├─ Página 1 → 100 tx → syncRunId: abc123                │
│    ├─ Página 2 → 100 tx → hasMore: true                    │
│    ├─ Página 3 → 50 tx → hasMore: false ✓                  │
│                                                             │
│  Chunk 2: Diciembre 2025                                    │
│    ├─ Página 1 → 100 tx → syncRunId: def456                │
│    └─ ...                                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Sección Técnica

### Cambios Específicos

**APISyncPanel.tsx - Nueva función `syncPayPalPaginated`:**

```typescript
const syncPayPalPaginated = async (
  startDate: Date, 
  endDate: Date
): Promise<number> => {
  let syncRunId: string | null = null;
  let hasMore = true;
  let page = 1;
  let totalSynced = 0;
  
  while (hasMore && page <= 500) {
    const data = await invokeWithAdminKey<FetchPayPalResponse, FetchPayPalBody>(
      'fetch-paypal',
      { 
        fetchAll: true,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        syncRunId,
        page
      }
    );
    
    if (!data.success) break;
    
    syncRunId = data.syncRunId || syncRunId;
    hasMore = data.hasMore === true;
    page = data.nextPage || (page + 1);
    totalSynced += data.synced_transactions || 0;
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  return totalSynced;
};
```

**fetch-paypal/index.ts - Líneas 340-378:**

```typescript
// Permitir continuar sync existente sin bloquear
if (!syncRunId) {
  // Check existing sync...
} 
// Si ya tiene syncRunId, saltar check de "sync already running"
```

**fetch-paypal/index.ts - Líneas 543-555:**

```typescript
// Leer valores actuales antes de actualizar
const { data: currentRun } = await supabase
  .from('sync_runs')
  .select('total_fetched, total_inserted')
  .eq('id', syncRunId)
  .single();

await supabase.from('sync_runs').update({
  status: 'continuing',
  total_fetched: (currentRun?.total_fetched || 0) + transactionsSaved,
  total_inserted: (currentRun?.total_inserted || 0) + transactionsSaved,
  checkpoint: { page, totalPages, lastActivity: new Date().toISOString() }
}).eq('id', syncRunId);
```

### Resultado Esperado

- Cada página de PayPal se procesa completamente
- Los contadores muestran progreso real acumulado
- Sin syncs bloqueados que impidan nuevas ejecuciones
- Consistencia con el patrón ya probado de facturas Stripe
