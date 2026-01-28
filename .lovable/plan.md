

# Plan de Reparación: Sección Clientes 360°

## Resumen de Cambios

Este plan corrige los 3 problemas críticos identificados en la auditoría:

| Prioridad | Problema | Solución |
|-----------|----------|----------|
| 🔴 ALTA | LTV solo suma Stripe ($194 vs $654 real) | Edge Function que recalcula desde TODAS las transacciones |
| 🔴 ALTA | 8,376 CUSTOMER sin suscripción activa | Automatización de lifecycle_stage con lógica determinista |
| 🟡 MEDIA | Perfil limitado (10 transacciones, sin subs) | CustomerDrawer 360° con timeline completo y suscripciones |

---

## FASE 1: Reparación del LTV Real

### Problema Confirmado
```text
Cliente: cjmorales2009@gmail.com
Stored LTV:     $194 (solo Stripe CSV)
Calculated LTV: $654 (Stripe + PayPal + Web)
Transacciones:  42 (fuentes: stripe, paypal, web)
```

### Solución: Nueva Edge Function `recalculate-ltv`

Crearemos una función que:
1. Agrupe transacciones por `customer_email`
2. Sume `amount` donde `status IN ('succeeded', 'paid')`
3. Actualice `clients.total_spend` con el resultado

```text
supabase/functions/recalculate-ltv/index.ts

Lógica:
- Parámetro: { batchSize: 1000, dryRun: false }
- Query: SUM(amount) FROM transactions GROUP BY customer_email
- Update: clients.total_spend WHERE email = transactions.customer_email
- Checkpoint: Actualiza sync_runs para tracking de progreso
```

### Cambios en Código

| Archivo | Acción |
|---------|--------|
| `supabase/functions/recalculate-ltv/index.ts` | CREAR - Edge Function con batch processing |
| `supabase/config.toml` | ACTUALIZAR - Agregar configuración de la función |

---

## FASE 2: Automatización de Lifecycle Stage

### Problema Confirmado
```text
┌────────────────┬─────────────┬──────────────┬──────────────┐
│ lifecycle_stage│ Total       │ Con Sub Activa│ Sin Sub Activa│
├────────────────┼─────────────┼──────────────┼──────────────┤
│ LEAD           │ 210,737     │ 130          │ 210,607      │
│ CUSTOMER       │ 9,532       │ 1,015        │ 8,517 ❌     │
│ CHURN          │ 683         │ 0            │ 683          │
└────────────────┴─────────────┴──────────────┴──────────────┘

8,517 usuarios marcados como CUSTOMER pero sin suscripción activa
```

### Solución: Lógica Determinista

La Edge Function `recalculate-ltv` también actualizará `lifecycle_stage`:

```text
LÓGICA DE CLASIFICACIÓN:

1. Si tiene suscripción 'active' o 'trialing'
   → CUSTOMER (o TRIAL si trialing)

2. Si NO tiene suscripción activa PERO tiene transacciones exitosas
   → Si última transacción < 30 días → CUSTOMER (gracia)
   → Si última transacción > 30 días → CHURN

3. Si NO tiene transacciones exitosas
   → LEAD
```

### Query SQL Equivalente
```sql
UPDATE clients c SET lifecycle_stage = 
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM subscriptions s 
      WHERE s.customer_email = c.email 
        AND s.status IN ('active', 'trialing')
    ) THEN 'CUSTOMER'
    WHEN EXISTS (
      SELECT 1 FROM transactions t 
      WHERE t.customer_email = c.email 
        AND t.status IN ('succeeded', 'paid')
        AND t.stripe_created_at > NOW() - INTERVAL '30 days'
    ) THEN 'CUSTOMER'
    WHEN EXISTS (
      SELECT 1 FROM transactions t 
      WHERE t.customer_email = c.email 
        AND t.status IN ('succeeded', 'paid')
    ) THEN 'CHURN'
    ELSE 'LEAD'
  END
```

---

## FASE 3: Customer Drawer 360°

### Mejoras al Panel Lateral

```text
ANTES:
┌──────────────────────────┐
│ Nombre + Badge Status    │
│ ─────────────────────── │
│ Email / Teléfono         │
│ ─────────────────────── │
│ LTV: $194 ❌             │
│ Pagos: 3 (de 42) ❌      │
│ ─────────────────────── │
│ Timeline (últimos 10)    │
│   - Pago 1               │
│   - Pago 2               │
│   ...                    │
└──────────────────────────┘

DESPUÉS:
┌──────────────────────────┐
│ Nombre + Badge Status    │
│ ─────────────────────── │
│ Email / Teléfono         │
│ ─────────────────────── │
│ LTV: $654 ✅             │
│ Pagos: 42 ✅             │
│ ─────────────────────── │
│ 🎫 SUSCRIPCIÓN ACTIVA    │ ← NUEVO
│ Plan: Mensual $35        │
│ Renovación: 15 Feb 2026  │
│ ─────────────────────── │
│ 💬 COMUNICACIÓN (3)      │ ← NUEVO
│ Último mensaje: hace 2d  │
│ ─────────────────────── │
│ Timeline (completo)      │
│   - Ordenado por fecha   │
│   - Incluye PayPal+Web   │
│   ...                    │
└──────────────────────────┘
```

### Cambios en Código

| Archivo | Cambio |
|---------|--------|
| `src/components/dashboard/CustomerDrawer.tsx` | Quitar límite 10, agregar sección suscripciones, agregar sección mensajes |

### Queries Nuevas en CustomerDrawer

```typescript
// 1. Suscripciones activas del cliente
const { data: subscriptions } = useQuery({
  queryKey: ['client-subscriptions', client?.email],
  queryFn: async () => {
    if (!client?.email) return [];
    const { data } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('customer_email', client.email)
      .in('status', ['active', 'trialing', 'past_due'])
      .order('current_period_end', { ascending: false });
    return data;
  },
  enabled: open && !!client?.email,
});

// 2. Historial de mensajes
const { data: messages } = useQuery({
  queryKey: ['client-messages', client?.id],
  queryFn: async () => {
    if (!client?.id) return [];
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(20);
    return data;
  },
  enabled: open && !!client?.id,
});

// 3. Transacciones SIN LÍMITE con fecha unificada
const { data: transactions } = useQuery({
  queryKey: ['client-transactions', client?.email],
  queryFn: async () => {
    if (!client?.email) return [];
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('customer_email', client.email)
      .order('stripe_created_at', { ascending: false }); // Sin límite
    return data;
  },
  enabled: open && !!client?.email,
});
```

---

## Resumen de Archivos

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `supabase/functions/recalculate-ltv/index.ts` | CREAR | LTV + Lifecycle batch processor |
| `supabase/config.toml` | ACTUALIZAR | Agregar función |
| `src/components/dashboard/CustomerDrawer.tsx` | ACTUALIZAR | Vista 360° completa |

---

## Resultado Esperado Post-Implementación

### Métricas Corregidas

| Métrica | Antes | Después |
|---------|-------|---------|
| LTV (cjmorales2009@gmail.com) | $194 | $654 |
| Clientes con LTV > $0 | ~7,000 | ~18,000+ |
| CUSTOMER sin sub activa | 8,517 | 0 (reclasificados) |
| Transacciones visibles en perfil | 10 máx | Todas |
| Suscripción visible en perfil | No | Sí |
| Mensajes visibles en perfil | No | Sí |

### Verificación

Después de ejecutar el recálculo masivo:
1. El cliente ejemplo mostrará $654 en vez de $194
2. Los 8,517 ex-CUSTOMER serán reclasificados correctamente
3. El perfil del cliente mostrará suscripción activa y comunicaciones

---

## Detalles Técnicos

### Edge Function: recalculate-ltv

```typescript
// Pseudocódigo del procesamiento

async function recalculateBatch(supabase, batchSize, offset) {
  // 1. Obtener clientes con email
  const { data: clients } = await supabase
    .from('clients')
    .select('id, email')
    .not('email', 'is', null)
    .range(offset, offset + batchSize - 1);
  
  for (const client of clients) {
    // 2. Sumar transacciones
    const { data: txSum } = await supabase
      .from('transactions')
      .select('amount.sum()')
      .eq('customer_email', client.email)
      .in('status', ['succeeded', 'paid']);
    
    // 3. Verificar suscripción activa
    const { data: activeSub } = await supabase
      .from('subscriptions')
      .select('id, status')
      .eq('customer_email', client.email)
      .in('status', ['active', 'trialing'])
      .limit(1);
    
    // 4. Determinar lifecycle
    let lifecycleStage = 'LEAD';
    if (activeSub?.length > 0) {
      lifecycleStage = activeSub[0].status === 'trialing' ? 'TRIAL' : 'CUSTOMER';
    } else if (txSum > 0) {
      // Verificar última transacción
      const { data: lastTx } = await supabase
        .from('transactions')
        .select('stripe_created_at')
        .eq('customer_email', client.email)
        .order('stripe_created_at', { ascending: false })
        .limit(1);
      
      const daysSinceLast = differenceInDays(new Date(), lastTx?.[0]?.stripe_created_at);
      lifecycleStage = daysSinceLast <= 30 ? 'CUSTOMER' : 'CHURN';
    }
    
    // 5. Actualizar cliente
    await supabase
      .from('clients')
      .update({ 
        total_spend: txSum, 
        lifecycle_stage: lifecycleStage 
      })
      .eq('id', client.id);
  }
  
  return { processed: clients.length, hasMore: clients.length === batchSize };
}
```

### CustomerDrawer: Sección Suscripciones

```tsx
// Nueva sección en CustomerDrawer.tsx

{/* Active Subscription Card */}
{subscriptions && subscriptions.length > 0 && (
  <div className="mb-4 sm:mb-6">
    <h3 className="text-xs sm:text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
      <CreditCard className="h-4 w-4" />
      Suscripción Activa
    </h3>
    {subscriptions.map((sub) => (
      <div key={sub.id} className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
        <div className="flex justify-between items-center">
          <span className="font-medium text-sm">{sub.plan_name}</span>
          <Badge variant="outline" className="text-emerald-400">
            {sub.status}
          </Badge>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          <div className="flex justify-between">
            <span>Monto:</span>
            <span>${(sub.amount / 100).toFixed(2)}/{sub.interval}</span>
          </div>
          {sub.current_period_end && (
            <div className="flex justify-between">
              <span>Renovación:</span>
              <span>{format(new Date(sub.current_period_end), 'd MMM yyyy', { locale: es })}</span>
            </div>
          )}
        </div>
      </div>
    ))}
  </div>
)}
```

