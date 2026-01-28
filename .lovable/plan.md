
# Plan: Reparación de Unificación de Contactos y Visualización en Dashboard

## Diagnóstico del Problema

### Problema Principal: Discrepancia de Estado
El frontend del **SyncOrchestrator** busca `processing_status = 'staged'` pero todos los 664,048 registros CSV tienen `processing_status = 'pending'`. Esto hace que la UI muestre **"0 contactos para unificar"** cuando en realidad hay más de **850,000 registros pendientes** en total.

### Estado Actual de los Datos
| Tabla | Total | Pendientes |
|-------|-------|------------|
| `ghl_contacts_raw` | 188,256 | 188,256 |
| `csv_imports_raw` | 664,048 | 664,048 (status='pending') |
| `manychat_contacts_raw` | 0 | 0 |
| `clients` | 221,031 | Ya unificados |
| `transactions` | 175,734 | Stripe: 118k, PayPal: 38k, Web: 18k |
| `invoices` | 79,911 | Sincronizadas |
| `subscriptions` | 1,645 | 1,332 activas |

### Archivos Afectados

1. **SyncOrchestrator.tsx** (líneas 131-134): Busca solo `'staged'`, ignora `'pending'`
2. **bulk-unify-contacts**: Ya funciona correctamente (busca ambos estados)

---

## Solución en 3 Partes

### Parte 1: Arreglar el Conteo en el Frontend

**Archivo:** `src/components/dashboard/SyncOrchestrator.tsx`

**Cambio:** Modificar la query de conteo de CSV para incluir ambos estados:

```typescript
// ANTES (línea 131-134):
const { count: csvStaged } = await supabase
  .from('csv_imports_raw')
  .select('*', { count: 'exact', head: true })
  .eq('processing_status', 'staged'); // ❌ Solo 'staged'

// DESPUÉS:
const { count: csvStaged } = await supabase
  .from('csv_imports_raw')
  .select('*', { count: 'exact', head: true })
  .in('processing_status', ['staged', 'pending']); // ✅ Ambos estados
```

### Parte 2: Optimizar el Mensaje de "Nada que Unificar"

**Archivo:** `src/components/dashboard/SyncOrchestrator.tsx`

Agregar lógica para mostrar el mensaje correcto cuando hay datos disponibles pero el conteo estaba erróneo:

- Mostrar un botón de **"Refrescar Conteos"** que fuerza un recount
- Agregar indicador visual cuando hay datos en staging

### Parte 3: Verificar que Todas las Vistas Muestran Data

Las siguientes secciones ya funcionan correctamente porque consultan directamente las tablas finales:

| Sección | Tabla | Estado |
|---------|-------|--------|
| Command Center | `transactions`, `clients` | ✅ OK - 175k transacciones |
| Movimientos | `transactions` | ✅ OK - Muestra Stripe/PayPal/Web |
| Recovery | `invoices` (status=open) | ✅ OK |
| Facturas | `invoices` | ✅ OK - 79,911 facturas |
| Clientes | `clients` | ✅ OK - 221,031 clientes |
| Suscripciones | `subscriptions` | ✅ OK - 1,645 suscripciones |
| Analíticas | `daily_kpi_cache`, `transactions` | ✅ OK |

---

## Cambios Específicos

### Archivo 1: `src/components/dashboard/SyncOrchestrator.tsx`

**Líneas 131-134** - Cambiar filtro de CSV:
```typescript
// Antes
.eq('processing_status', 'staged')

// Después  
.in('processing_status', ['staged', 'pending'])
```

**Agregar mensaje informativo** cuando hay datos disponibles:
```typescript
// En la sección de "Fase 2: Unificar Contactos", agregar:
{pendingCounts.total > 0 && (
  <Badge variant="outline" className="border-green-500 text-green-500">
    {pendingCounts.total.toLocaleString()} contactos listos para unificar
  </Badge>
)}
```

---

## Resultado Esperado

Después de implementar estos cambios:

1. **SyncOrchestrator** mostrará correctamente:
   - GHL: 188,256 contactos pendientes
   - CSV: 664,048 registros pendientes
   - Total: ~852,304 contactos para unificar

2. El botón **"Unificar Todo"** funcionará y procesará los datos en background

3. Los datos unificados aparecerán en:
   - **Clientes**: Se actualizarán con datos de GHL/CSV
   - **Movimientos**: Ya tienen 175k transacciones visibles
   - **Facturas**: Ya muestran 79k+ facturas
   - **Suscripciones**: Ya muestran 1,645 registros
   - **Command Center**: Mostrará KPIs actualizados

---

## Notas Técnicas

- La función `bulk-unify-contacts` procesa en batches de 200 registros
- Tiempo estimado para 850k registros: ~70-90 minutos
- El proceso corre en background usando `EdgeRuntime.waitUntil()`
- Se puede cancelar en cualquier momento desde la UI
- El progreso se actualiza en tiempo real cada 2 segundos

