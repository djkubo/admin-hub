
# Plan de Emergencia: Eliminar Queries Pesadas que Causan 503

## Diagnóstico Confirmado

El Dashboard carga **4 hooks** al inicio. Aunque `useDailyKPIs` y `useSubscriptions` ya usan RPCs optimizados, los otros 2 hooks siguen haciendo queries directas que causan los timeouts:

| Hook | Problema | Impacto |
|------|----------|---------|
| `useDailyKPIs` | ✅ Usa `kpi_mrr_summary` RPC | OK |
| `useSubscriptions` | ✅ Usa `kpi_mrr_summary` RPC | OK |
| `useMetrics` | ❌ Query a `transactions` (5000 rows) | **503 Timeout** |
| `useInvoices` | ❌ Query a `invoices` con JOIN a `clients` (1000 rows + 221k clients) | **503 Timeout** |

---

## Solución Propuesta

### 1. Optimizar `useMetrics.ts`

**Problema actual** (líneas 84-90):
```typescript
const { data: monthlyTransactions } = await supabase
  .from('transactions')
  .select('amount, currency, status, stripe_created_at')
  .gte('stripe_created_at', firstDayOfMonth.toISOString())
  .in('status', ['succeeded', 'paid', 'refunded'])
  .limit(5000); // ← Sigue descargando 5000 filas
```

**Solución**: Crear un RPC `kpi_sales_summary()` que calcule los totales en el servidor:

```sql
CREATE OR REPLACE FUNCTION kpi_sales_summary(p_start_date date DEFAULT NULL)
RETURNS TABLE(
  sales_usd bigint,
  sales_mxn bigint,
  refunds_usd bigint,
  refunds_mxn bigint,
  today_usd bigint,
  today_mxn bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET statement_timeout TO '10s'
AS $$
  SELECT 
    COALESCE(SUM(amount) FILTER (WHERE status IN ('succeeded','paid') AND (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('succeeded','paid') AND lower(currency) = 'mxn'), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status = 'refunded' AND lower(currency) = 'mxn'), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('succeeded','paid') AND stripe_created_at >= CURRENT_DATE AND (currency IS NULL OR lower(currency) = 'usd')), 0)::bigint,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('succeeded','paid') AND stripe_created_at >= CURRENT_DATE AND lower(currency) = 'mxn'), 0)::bigint
  FROM transactions
  WHERE stripe_created_at >= COALESCE(p_start_date, date_trunc('month', CURRENT_DATE));
$$;
```

### 2. Optimizar `useInvoices.ts`

**Problema actual** (líneas 114-126):
```typescript
let query = supabase
  .from("invoices")
  .select(`*, client:clients!client_id (...)`)
  .order("stripe_created_at", { ascending: false })
  .limit(1000); // ← JOIN con 221k clients causa timeout
```

**Solución A (Inmediata)**: Eliminar el JOIN con clients y reducir el límite inicial:
```typescript
.select("*")  // Sin JOIN
.limit(100)   // Reducir de 1000 a 100
```

**Solución B (RPC para totales)**: Crear `kpi_invoices_summary()` para los totales del Dashboard:
```sql
CREATE OR REPLACE FUNCTION kpi_invoices_summary()
RETURNS TABLE(
  pending_total bigint,
  paid_total bigint,
  next_72h_total bigint,
  next_72h_count bigint,
  uncollectible_total bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET statement_timeout TO '10s'
AS $$
  SELECT 
    COALESCE(SUM(amount_due) FILTER (WHERE status IN ('open', 'draft')), 0)::bigint,
    COALESCE(SUM(amount_paid) FILTER (WHERE status = 'paid'), 0)::bigint,
    COALESCE(SUM(amount_due) FILTER (WHERE status IN ('open', 'draft') AND next_payment_attempt <= NOW() + INTERVAL '72 hours'), 0)::bigint,
    COUNT(*) FILTER (WHERE status IN ('open', 'draft') AND next_payment_attempt <= NOW() + INTERVAL '72 hours')::bigint,
    COALESCE(SUM(amount_due) FILTER (WHERE status = 'uncollectible'), 0)::bigint
  FROM invoices;
$$;
```

### 3. Modificar DashboardHome para Carga Lazy

En `DashboardHome.tsx`, cambiar la llamada a `useInvoices()` para que NO cargue los datos al inicio:

```typescript
// ANTES
const { invoicesNext72h } = useInvoices();

// DESPUÉS - Solo cargar cuando se necesite navegar a Invoices
const { invoicesNext72h } = useInvoices({ skip: true }); // O eliminar del todo
```

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| Migración SQL | Crear RPCs `kpi_sales_summary` y `kpi_invoices_summary` |
| `src/hooks/useMetrics.ts` | Reemplazar query de transactions por RPC |
| `src/hooks/useInvoices.ts` | Eliminar JOIN, reducir límite, agregar query al RPC para totales |
| `src/components/dashboard/DashboardHome.tsx` | Remover dependencia directa de `useInvoices` si no es crítica |

---

## Impacto Esperado

| Métrica | Antes | Después |
|---------|-------|---------|
| Query `transactions` (5000 rows) | 5-15s (timeout) | <200ms (RPC) |
| Query `invoices` con JOIN | 8-20s (timeout) | <300ms (sin JOIN) |
| Dashboard load time | Infinito (crash) | <2 segundos |

---

## Orden de Ejecución

1. **Migración SQL**: Crear los 2 nuevos RPCs
2. **useInvoices.ts**: Eliminar JOIN y reducir límite a 100
3. **useMetrics.ts**: Reemplazar query por llamada al RPC
4. **DashboardHome.tsx**: Evaluar si `invoicesNext72h` es crítico para la vista inicial (opcional: lazy load)

---

## Nota Importante

Los cambios de código que hice anteriormente **ya están en el código fuente** (puedes verificarlo en las líneas 119-147 de `useDailyKPIs.ts`). Sin embargo, el problema es que:

1. **useMetrics** y **useInvoices** NO fueron optimizados
2. Estas queries pesadas se ejecutan EN PARALELO con los RPCs optimizados
3. Cuando las queries pesadas fallan (503), el browser puede reportar errores en todas las llamadas

El código desplegado ES el código actual. Lo que necesitamos es completar la optimización de los hooks restantes.
