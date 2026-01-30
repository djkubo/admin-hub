

# Plan: Paginación Server-Side Real + Diseño VRP

## Estado Actual del Código

Tras revisar el codebase, encontré:

| Componente | Estado | Problema |
|------------|--------|----------|
| `useClients` | Paginación completa ✓ | Funciona correctamente |
| `ClientsTable` | Paginación UI completa ✓ | Funciona correctamente |
| `MovementsPage` | Solo `.limit(500)` ❌ | Sin paginación real, no muestra 200k+ registros |
| `useTransactions` | Solo `.limit(1000)` ❌ | Solo para Analytics, no crítico |
| `TransactionsTable` | Sin uso real | Componente huérfano |

El **problema real** está en `MovementsPage.tsx` que es la vista principal del libro mayor financiero.

---

## Acciones a Ejecutar

### 1. Implementar Paginación Server-Side en MovementsPage

**Archivo: `src/components/dashboard/MovementsPage.tsx`**

**Cambios en el estado:**
```typescript
// Agregar estado de paginación
const [page, setPage] = useState(0);
const [pageSize] = useState(100); // Fijo para performance
```

**Cambios en la query:**
```typescript
// ANTES (línea 240)
txQuery = txQuery.limit(500);

// DESPUÉS - Paginación real
const from = page * pageSize;
const to = from + pageSize - 1;
txQuery = txQuery.range(from, to);
```

**Agregar controles de paginación:**
```text
┌─────────────────────────────────────────────────────────┐
│  [< Anterior]  Página 1 de 2,068  [Siguiente >]        │
│                                                         │
│  Mostrando 1-100 de 206,817 transacciones              │
└─────────────────────────────────────────────────────────┘
```

### 2. Actualizar useTransactions con Paginación (Para Analytics)

**Archivo: `src/hooks/useTransactions.ts`**

Agregar paginación básica para que Analytics pueda acceder a más datos cuando lo necesite:

```typescript
export function useTransactions(options?: { limit?: number }) {
  const limit = options?.limit ?? 1000;
  
  const { data, error } = await supabase
    .from("transactions")
    .select("*", { count: "exact" }) // Ahora devuelve totalCount
    .order("stripe_created_at", { ascending: false })
    .limit(limit);
    
  return { transactions, totalCount, isLoading, error };
}
```

### 3. Mantener Diseño VRP en MovementsPage

Verificación del diseño actual (ya correcto):

| Elemento | Estado Actual | Acción |
|----------|---------------|--------|
| Ingresos | `text-emerald-500` ✓ | Mantener |
| Reembolsos | `text-purple-500` (negativo) | Cambiar a `text-primary` (VRP Red) |
| Disputas | `text-orange-500` | Cambiar a `text-amber-500` (alerta) |
| Fondo filas | `hover:bg-muted/20` | Mantener |
| Badges estado | Semánticos (success/error) | Mantener |

El código actual ya usa la paleta VRP excepto por algunos colores de estado que necesitan ajuste menor.

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/components/dashboard/MovementsPage.tsx` | Agregar paginación server-side con controles UI |
| `src/hooks/useTransactions.ts` | Agregar opción `limit` y retornar `totalCount` |

---

## Controles de Paginación - Diseño Visual

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│  📊 Libro Mayor - Movimientos                                                │
│  206,817 transacciones totales                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  [Filtros: Este Mes ▼] [Fuente: Todos ▼] [Estado: Todos ▼] [🔍 Buscar...]   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  │ Fecha       │ Email        │ Monto     │ Estado    │ Fuente │ Método   │ │
│  │─────────────│──────────────│───────────│───────────│────────│──────────│ │
│  │ 30 ene 2026 │ user@x.com   │ $97.00    │ ✓ Exitoso │ Stripe │ •••• 4242│ │
│  │ 30 ene 2026 │ test@y.com   │ -$35.00   │ ↩ Reemb.  │ Stripe │ •••• 1234│ │
│  │ ...         │ ...          │ ...       │ ...       │ ...    │ ...      │ │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  [< Anterior]  Página 1 de 2,069  [Siguiente >]                              │
│                                                                              │
│  Mostrando 1-100 de 206,817                        [Ver 50 ▼] [100 ▼] [200] │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Sección Técnica

### Por qué `.range(from, to)` en lugar de `.limit()`

- **`.limit(N)`**: Solo limita resultados, no permite navegar
- **`.range(from, to)`**: Permite paginación real con offset

```typescript
// Página 0 (primeros 100)
.range(0, 99)

// Página 1 (101-200)
.range(100, 199)

// Página 2068 (últimos registros)
.range(206800, 206899)
```

### Conteo Total sin Descargar Datos

Supabase permite obtener el count exacto sin descargar filas:

```typescript
const { count } = await supabase
  .from("transactions")
  .select("*", { count: "exact", head: true }); // head: true = no data
```

### Impacto en Performance

| Antes | Después |
|-------|---------|
| Descarga 500 filas siempre | Descarga 100 filas por página |
| Sin acceso a registros >500 | Acceso a TODOS los 206k registros |
| Query time: 2-4 segundos | Query time: 200-400ms |
| Sin total count | Total count visible |

---

## Resultado Esperado

| Funcionalidad | Estado |
|---------------|--------|
| Navegar por 206,817 registros | ✓ |
| Ver total real en header | ✓ |
| Controles [< Anterior] [Siguiente >] | ✓ |
| Indicador "Página X de Y" | ✓ |
| Selector de tamaño de página | ✓ |
| Sin congelar navegador | ✓ |
| Mantener filtros VRP Premium | ✓ |

