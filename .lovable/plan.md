
# Plan de Reparación: Fix "Unificar Todos" que no Procesa

## Diagnóstico Confirmado

### El Problema
Los upserts a la tabla `clients` están fallando por **timeout de Postgres (2 minutos)**. Cuando se intentan insertar 2,000 registros de golpe, la operación excede el límite de tiempo y es cancelada por la base de datos.

### Por qué marcó "completed" sin procesar:
El código actual interpreta `batchProcessed === 0` como "no hay más trabajo" cuando en realidad los upserts fallaron silenciosamente.

---

## Solución en 3 Partes

### Parte 1: Reducir Batch Size Drásticamente
Cambiar de 2,000 → **100 registros por upsert** para completar cada operación en segundos en lugar de minutos.

```text
ANTES: 2,000 registros → timeout después de 2min
AHORA: 100 registros → ~3-5 segundos por upsert
```

### Parte 2: Usar Upserts Individuales con Reintentos
En lugar de un mega-upsert de 100 registros, procesar en micro-batches de 25 con manejo de errores granular.

```text
┌─────────────────────────────────────────────────────────┐
│              ESTRATEGIA DE MICRO-BATCHES                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Batch de 100 registros:                                │
│  ├─ Micro-batch 1: 25 registros → Upsert → OK ✓        │
│  ├─ Micro-batch 2: 25 registros → Upsert → OK ✓        │
│  ├─ Micro-batch 3: 25 registros → Upsert → OK ✓        │
│  └─ Micro-batch 4: 25 registros → Upsert → OK ✓        │
│                                                         │
│  Si un micro-batch falla:                               │
│  ├─ Reintentar 1 vez después de 500ms                  │
│  └─ Si falla de nuevo, registrar y continuar           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Parte 3: Lógica de "hasMoreWork" Corregida
El código actual marca "completed" cuando `batchProcessed === 0`, pero esto es incorrecto si hubo errores. 

Nueva lógica:
- Si hay timeouts → Marcar como "paused" con cursor de reanudación
- Si `batchProcessed === 0` Y no hubo errores → Marcar como "completed"

---

## Cambios en el Código

### Archivo: `supabase/functions/bulk-unify-contacts/index.ts`

**1. Constantes actualizadas:**
```typescript
// ANTES
const BATCH_SIZE_DEFAULT = 2000;
const BATCH_DELAY_MS = 5;

// AHORA
const BATCH_SIZE_DEFAULT = 100;    // Reduced for stability
const MICRO_BATCH_SIZE = 25;       // Upsert in smaller chunks
const BATCH_DELAY_MS = 50;         // Slightly more delay
```

**2. Nueva función de micro-upsert:**
```typescript
async function upsertWithRetry(
  supabase: SupabaseClient,
  table: string,
  records: Record<string, unknown>[],
  onConflict: string,
  ignoreDuplicates: boolean
): Promise<{ success: number; failed: number }> {
  const results = { success: 0, failed: 0 };
  
  // Split into micro-batches of 25
  for (let i = 0; i < records.length; i += MICRO_BATCH_SIZE) {
    const microBatch = records.slice(i, i + MICRO_BATCH_SIZE);
    
    // Try upsert with 1 retry
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await supabase
        .from(table)
        .upsert(microBatch, { onConflict, ignoreDuplicates });
      
      if (!error) {
        results.success += microBatch.length;
        break;
      } else if (attempt === 0) {
        await delay(500); // Wait before retry
      } else {
        results.failed += microBatch.length;
        log('warn', `Micro-batch failed: ${error.message}`);
      }
    }
  }
  
  return results;
}
```

**3. Actualizar processGHLBatch, processManyChatBatch, processCSVBatch:**
Reemplazar los upserts directos con llamadas a `upsertWithRetry()`.

**4. Lógica de "hasMoreWork" mejorada:**
```typescript
// ANTES (incorrecto)
if (batchProcessed === 0) {
  break; // Assumes no more work
}

// DESPUÉS (correcto)
if (batchProcessed === 0) {
  // Double-check: are there really no pending records?
  const freshCounts = await getPendingCounts(supabase);
  if (freshCounts.total === 0) {
    break; // Confirmed: no more work
  } else {
    // There are still records but we couldn't process them
    // Mark as paused so we can retry
    await supabase
      .from('sync_runs')
      .update({
        status: 'paused',
        error_message: 'Batch processing stalled, check for DB timeouts',
        checkpoint: { cursor: currentCursor, canResume: true }
      })
      .eq('id', syncRunId);
    return; // Exit and wait for manual resume
  }
}
```

---

## Estimaciones de Rendimiento

| Configuración | Batch | Velocidad Esperada | Tiempo para 800k |
|---------------|-------|-------------------|------------------|
| **Antes (roto)** | 2,000 | 0/s (timeouts) | ∞ |
| **Después (fix)** | 100 (25 micro) | ~100-150/s | ~90-120 min |

Aunque es más lento que el diseño teórico, es **estable y confiable**.

---

## Archivos a Modificar

1. **`supabase/functions/bulk-unify-contacts/index.ts`**
   - Reducir `BATCH_SIZE_DEFAULT` de 2,000 → 100
   - Añadir `MICRO_BATCH_SIZE = 25`
   - Crear función `upsertWithRetry()`
   - Actualizar las 3 funciones de proceso (GHL, ManyChat, CSV)
   - Corregir lógica de "hasMoreWork"

---

## Resultado Esperado

### Antes:
- Botón "Unificar" → Timeouts → Marca "completed" falsamente → 0 registros procesados

### Después:
- Botón "Unificar" → Micro-batches de 25 → Progreso real → ~100/s estable → 800k en ~2 horas
- Si hay problemas → Marca "paused" → Permite "Reanudar"
