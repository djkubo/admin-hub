

# Plan: Conectar Dashboard a los RPCs Optimizados

## Estado Actual

✅ **Los RPCs ya existen y funcionan en la base de datos**:
- `kpi_mrr_summary()` → Devuelve MRR: $69,009.50 | 1,332 activas | $16,223 en riesgo | 208 en riesgo
- `kpi_invoices_at_risk()` → Disponible (tuvo timeout en el test pero existe)

❌ **El código actual NO los usa**:
- `useDailyKPIs.ts` → Sigue haciendo queries con `.limit(2000)` que devuelven datos incompletos
- `useSubscriptions.ts` → Limitado a 100 registros, mostrando métricas incorrectas

---

## Cambios a Realizar

### 1. Actualizar `useDailyKPIs.ts`

Reemplazar las queries directas a `subscriptions` e `invoices` por llamadas a los RPCs:

```text
ANTES (líneas 120-129):
├── supabase.from('subscriptions').select(...).limit(2000) ❌
└── supabase.from('invoices').select(...).limit(1000) ❌

DESPUÉS:
├── supabase.rpc('kpi_mrr_summary') ✅
└── (El RPC ya incluye todo: MRR, at_risk_amount, counts)
```

**Resultado**: MRR y Revenue at Risk mostrarán valores REALES de toda la base de datos.

---

### 2. Actualizar `useSubscriptions.ts`

Agregar una query separada para obtener las métricas agregadas del RPC, manteniendo la query de listado para la tabla:

```text
ANTES:
├── Query con .limit(100) para listado ✅ (OK para la tabla)
├── totalActiveRevenue = sum(subscriptions.filter(active)) ❌ (solo 100 registros)
└── revenueAtRisk = sum(subscriptions.filter(at_risk)) ❌ (solo 100 registros)

DESPUÉS:
├── Query con .limit(100) para listado ✅ (mantener)
├── supabase.rpc('kpi_mrr_summary') para métricas ✅
└── totalActiveRevenue/revenueAtRisk del RPC ✅ (datos completos)
```

---

## Impacto Esperado

| Métrica | Antes (límites) | Después (RPCs) |
|---------|-----------------|----------------|
| MRR | ~$3,000 (parcial) | $69,009.50 (real) |
| Suscripciones activas | ~100 | 1,332 |
| Revenue at Risk | ~$500 (parcial) | $16,223 (real) |
| Subs en riesgo | ~10 | 208 |
| Tiempo de carga | 2-8s (timeouts) | <500ms |

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/hooks/useDailyKPIs.ts` | Reemplazar queries 7 y 8 por llamada a `kpi_mrr_summary` RPC |
| `src/hooks/useSubscriptions.ts` | Agregar query al RPC para métricas agregadas |

---

## Sección Técnica

### Cambio en useDailyKPIs.ts

```typescript
// Eliminar promises[7] y promises[8] (queries directas)
// Agregar:
supabase.rpc('kpi_mrr_summary')

// Extraer resultados:
if (promises[7].status === 'fulfilled' && promises[7].value?.data) {
  const mrrSummary = promises[7].value.data[0];
  mrr = (mrrSummary?.mrr || 0) / 100;
  mrrActiveCount = mrrSummary?.active_count || 0;
  revenueAtRisk = (mrrSummary?.at_risk_amount || 0) / 100;
  revenueAtRiskCount = mrrSummary?.at_risk_count || 0;
}
```

### Cambio en useSubscriptions.ts

```typescript
// Agregar query al RPC (separada de la query de listado)
const { data: mrrSummary } = useQuery({
  queryKey: ["mrr-summary"],
  queryFn: async () => {
    const { data, error } = await supabase.rpc('kpi_mrr_summary');
    if (error) throw error;
    return data?.[0];
  },
  staleTime: 60000,
});

// Usar valores del RPC en lugar de calcular desde los 100 registros
const totalActiveRevenue = (mrrSummary?.mrr || 0) / 100;
const totalActiveCount = mrrSummary?.active_count || 0;
const revenueAtRisk = (mrrSummary?.at_risk_amount || 0) / 100;
const atRiskCount = mrrSummary?.at_risk_count || 0;
```

---

## Orden de Ejecución

1. Modificar `useDailyKPIs.ts` para usar el RPC
2. Modificar `useSubscriptions.ts` para usar el RPC
3. El Dashboard mostrará métricas 100% precisas inmediatamente

