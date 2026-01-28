
# Plan de Reparación: Bulk Unify Atascado

## Diagnóstico

### Problema Identificado
El sync de unificación masiva está **atascado** en estado `continuing`:
- **Procesados**: 3,600 de 852,304 (0.4%)
- **Última actividad**: hace ~22 minutos
- **Velocidad**: 11.9/s (antes de atascarse)

### Causa Raíz
1. `EdgeRuntime.waitUntil` perdió la conexión sin marcar error
2. La detección de "stale sync" usa `started_at` en lugar del `lastUpdate` del checkpoint
3. Un proceso largo legítimo sería cancelado, pero uno atascado con `started_at` reciente no se detecta

---

## Cambios Propuestos

### 1. Corregir Detección de Stale (CRÍTICO)

Cambiar la lógica para usar el timestamp de última actividad del checkpoint:

```text
ANTES (línea 800-804):
  const startedAt = new Date(syncData.started_at).getTime();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  if (Date.now() - startedAt > staleThreshold) { ... }

DESPUÉS:
  const checkpoint = syncData.checkpoint as { lastUpdate?: string } | null;
  const lastActivity = checkpoint?.lastUpdate 
    ? new Date(checkpoint.lastUpdate).getTime()
    : new Date(syncData.started_at).getTime();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes sin actividad
  if (Date.now() - lastActivity > staleThreshold) { ... }
```

### 2. Agregar Auto-Resume (Reanudación Automática)

Cuando se detecta un sync stale, en lugar de solo cancelarlo, ofrecer reanudación:

```text
NUEVO FLUJO:
1. Si el sync está stale → Marcarlo como cancelled
2. Iniciar nuevo sync DESDE donde se quedó (resumir)
3. Los contactos ya procesados (processed_at no null) no se re-procesan
```

### 3. Reducir Batch Size para Estabilidad

El batch de 200 puede ser demasiado grande para 852k registros. Cambiar a batches más pequeños con checkpoints más frecuentes:

```text
ANTES:
  batchSize = 200
  checkpoint cada 1 iteración

DESPUÉS:
  batchSize = 100
  checkpoint cada 1 iteración
  timeout detection cada 50 iteraciones
```

### 4. Agregar Heartbeat y Recovery

Implementar un mecanismo de heartbeat que actualice el checkpoint cada N segundos incluso si no hay progreso, para distinguir entre "lento" y "atascado":

```text
while (hasMoreWork) {
  // Actualizar heartbeat antes de cada batch
  await updateHeartbeat(syncRunId);
  
  // Procesar batch
  const result = await batchProcess...();
  
  // Si llevamos >60s sin nuevo batch, algo está mal
  if (Date.now() - lastBatchComplete > 60000) {
    throw new Error('Batch timeout detected');
  }
}
```

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `supabase/functions/bulk-unify-contacts/index.ts` | Corregir stale detection, agregar heartbeat, reducir batch |

---

## Resumen de Cambios en Código

### Corrección de Stale Detection (líneas ~788-822)

```typescript
// NUEVO: Leer checkpoint para lastUpdate
const { data: existingSync } = await supabase
  .from('sync_runs')
  .select('id, status, started_at, checkpoint')  // <-- agregar checkpoint
  .eq('source', 'bulk_unify')
  .in('status', ['running', 'continuing', 'completing'])
  .order('started_at', { ascending: false })
  .limit(1)
  .single();

if (existingSync) {
  const syncData = existingSync as { 
    id: string; 
    status: string; 
    started_at: string;
    checkpoint: { lastUpdate?: string } | null;
  };
  
  // NUEVO: Usar lastUpdate del checkpoint en lugar de started_at
  const lastActivity = syncData.checkpoint?.lastUpdate 
    ? new Date(syncData.checkpoint.lastUpdate).getTime()
    : new Date(syncData.started_at).getTime();
  
  const staleThreshold = 5 * 60 * 1000; // 5 minutos sin actividad
  
  if (Date.now() - lastActivity > staleThreshold) {
    logger.info(`Cancelling stale sync: ${syncData.id} (inactive for ${Math.round((Date.now() - lastActivity) / 60000)} min)`);
    await supabase.from('sync_runs').update({ 
      status: 'cancelled', 
      error_message: `Stale: no activity for ${Math.round((Date.now() - lastActivity) / 60000)} minutes` 
    }).eq('id', syncData.id);
    // Continuar para iniciar nuevo sync
  } else {
    return new Response(JSON.stringify({ 
      ok: true, 
      message: 'Unification already in progress',
      syncRunId: syncData.id,
      status: syncData.status
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
```

### Reducción de Batch y Timeout Protection (línea ~763-764)

```typescript
// ANTES:
const { sources = ['ghl', 'manychat', 'csv'], batchSize = 200, forceCancel = false } = body;

// DESPUÉS:
const { sources = ['ghl', 'manychat', 'csv'], batchSize = 100, forceCancel = false } = body;
```

### Heartbeat en el Loop Principal (líneas ~630-706)

```typescript
// NUEVO: Agregar tracking de tiempo por batch
let lastBatchTime = Date.now();
const BATCH_TIMEOUT_MS = 120000; // 2 minutos máximo por batch

while (hasMoreWork && iterations < MAX_ITERATIONS) {
  iterations++;
  hasMoreWork = false;
  
  // NUEVO: Detectar timeout de batch
  if (Date.now() - lastBatchTime > BATCH_TIMEOUT_MS) {
    logger.error('Batch timeout detected, marking as failed');
    throw new Error(`Batch timeout after ${iterations} iterations`);
  }
  
  // Check if cancelled (existente)
  const { data: syncCheck } = await supabase...
  
  // Process each source (existente)
  for (const source of sources) {
    let result = await batchProcess...(supabase, batchSize, syncRunId);
    
    // NUEVO: Reset timer después de cada batch exitoso
    lastBatchTime = Date.now();
    
    totalProcessed += result.processed;
    ...
  }
  
  // Update progress (existente) - pero con timestamp forzado
  await supabase.from('sync_runs').update({
    status: hasMoreWork ? 'continuing' : 'completing',
    total_fetched: totalProcessed,
    total_inserted: totalMerged,
    checkpoint: {
      iterations,
      progressPct: Math.round(progressPct * 10) / 10,
      rate: `${rate}/s`,
      estimatedRemainingSeconds: estimatedRemaining,
      lastUpdate: new Date().toISOString()  // <-- ya existe, asegurar que se actualiza
    }
  }).eq('id', syncRunId);
  
  ...
}
```

---

## Acción Inmediata

Antes de los cambios de código, necesito cancelar el sync atascado actual para desbloquearte:

1. Llamar a `bulk-unify-contacts` con `{ forceCancel: true }`
2. Aplicar las optimizaciones de código
3. Re-ejecutar con la lógica mejorada

---

## Resultado Esperado

Después de estos cambios:
1. Syncs atascados se detectan en **5 minutos** (no 10+ horas)
2. Batches más pequeños = menos probabilidad de timeout
3. Heartbeat permite distinguir "lento pero funcionando" de "atascado"
4. El UI puede mostrar "Última actividad: hace X minutos" para transparencia
