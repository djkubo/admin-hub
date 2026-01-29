
# Plan de Reparación: Prioridades 2 y 3

## Resumen de Estado

### Prioridad 1 (Estabilidad): COMPLETADA
El botón "Unificar Todos" ya cuenta con:
- Edge Function v3 con auto-encadenamiento (chunks de 45s)
- Batch size aumentado de 500 → 2,000
- RPC `get_staging_counts_accurate` con índices parciales
- UI con polling adaptativo (5s/15s) y capacidad de resume

---

## Prioridad 2: Verdad Financiera (PayPal + Reembolsos)

### Hallazgos del Diagnóstico

**Datos actuales en la BD (desde 2024):**
| Fuente | Status | Total USD | Registros |
|--------|--------|-----------|-----------|
| PayPal | paid | $793,338 | 22,671 |
| Stripe | paid | $735,432 | 26,671 |
| Stripe | succeeded | $258,961 | 9,572 |
| Stripe | refunded | $1,777 | 40 |
| Web | succeeded | $103,421 | 2,033 |

**Problemas identificados:**
1. **Facturas** (`InvoicesPage.tsx`): Solo muestra `invoices` de Stripe, ignora los $793k de PayPal
2. **useMetrics.ts**: Calcula ventas BRUTAS sin descontar reembolsos
3. **MovementsPage.tsx**: YA TIENE el cálculo correcto de Net Revenue

### Solución 2A: Vista Unificada de Facturas/Recibos

**Archivos a modificar:**
- `src/hooks/useInvoices.ts` - Añadir query que incluya transacciones PayPal como "recibos"
- `src/components/dashboard/InvoicesPage.tsx` - Añadir toggle para ver "Stripe Invoices" vs "Todas las Transacciones"

**Lógica propuesta:**
```text
┌─────────────────────────────────────────────────────────┐
│                    FACTURAS UNIFICADAS                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Stripe Invoices]  [PayPal Recibos]  [Todos]          │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ $xxx,xxx    │  │ $793,338    │  │ $1.5M+      │     │
│  │ pendiente   │  │ cobrado     │  │ total       │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Nuevo hook `useUnifiedReceipts.ts`:**
- Query paralela a `invoices` (Stripe) y `transactions WHERE source='paypal' AND status='paid'`
- Normaliza ambos a un formato común: fecha, email, monto, fuente, status
- Calcula totales separados y combinados

### Solución 2B: Net Revenue en Analytics

**Archivo a modificar:**
- `src/hooks/useMetrics.ts`

**Cambio en lógica de cálculo:**
```typescript
// ANTES (línea ~84-96): Solo suma transacciones exitosas
for (const tx of monthlyTransactions || []) {
  const amountInCurrency = tx.amount / 100;
  // ... suma todo
}

// DESPUÉS: Resta reembolsos
const refundedAmount = monthlyTransactions
  .filter(tx => tx.status === 'refunded')
  .reduce((sum, tx) => sum + tx.amount, 0) / 100;

const netMonthUSD = salesMonthUSD - refundedAmount;
```

**Nuevo campo en `DashboardMetrics`:**
- `refundsMonthTotal: number`
- `netRevenueMonth: number`

**Actualización en `DashboardHome.tsx`:**
- Mostrar "Ventas Netas" en lugar de solo "Ventas"
- Opcionalmente: badge pequeño mostrando reembolsos

---

## Prioridad 3: Gobernanza (Settings)

### Hallazgos del Diagnóstico

**Secretos actuales (15 total):**
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_WEBHOOK_ID`
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_WHATSAPP_NUMBER`
- GHL: `GHL_API_KEY`, `GHL_LOCATION_ID`
- ManyChat: `MANYCHAT_API_KEY`
- AI: `OPENAI_API_KEY`
- Admin: `ADMIN_API_KEY`, `LOVABLE_API_KEY`

**Problema:** Estos secretos solo se pueden gestionar desde Lovable Cloud, no desde la UI de la app.

### Solución 3A: Panel de Estado de Integraciones

**Nuevo archivo:**
- `src/components/dashboard/IntegrationsStatusPanel.tsx`

**Funcionalidad:**
- Muestra el estado de cada integración (Conectado/Desconectado)
- Indica cuáles secretos están configurados (sin mostrar valores)
- Link a Lovable Cloud para rotación de claves
- Botón de "Test Connection" para verificar cada API

```text
┌─────────────────────────────────────────────────────────┐
│                 ESTADO DE INTEGRACIONES                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Stripe          🟢 Conectado    [Test] [Rotar ↗]      │
│  ├─ API Key      ✅ sk_live_••••                       │
│  └─ Webhook      ✅ whsec_••••                         │
│                                                         │
│  PayPal          🟢 Conectado    [Test] [Rotar ↗]      │
│  ├─ Client ID    ✅ ••••                               │
│  └─ Secret       ✅ ••••                               │
│                                                         │
│  Twilio          🟢 Conectado    [Test] [Rotar ↗]      │
│  ├─ Account SID  ✅ AC••••                             │
│  └─ Auth Token   ✅ ••••                               │
│                                                         │
│  ⚠️ Para rotar claves, usa Lovable Cloud Settings      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Solución 3B: Toggles de Sistema

**Nuevo archivo:**
- `src/components/dashboard/SystemTogglesPanel.tsx`

**Tabla `system_settings` - Nuevas claves:**
- `auto_dunning_enabled` (boolean) - Activar/desactivar dunning automático
- `sync_paused` (boolean) - Pausar todas las sincronizaciones
- `quiet_hours_start` (string) - Hora de inicio de horario silencioso
- `quiet_hours_end` (string) - Hora de fin de horario silencioso
- `company_name` (string) - Nombre de la empresa
- `timezone` (string) - Zona horaria por defecto

**UI:**
```text
┌─────────────────────────────────────────────────────────┐
│              CONFIGURACIÓN DEL SISTEMA                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Auto-Dunning          [====ON====]                     │
│  Envía recordatorios automáticos de pago               │
│                                                         │
│  Pausar Sincronización [====OFF===]                     │
│  Detiene todas las sincronizaciones                    │
│                                                         │
│  Horario Silencioso    [21:00] - [08:00]               │
│  No enviar mensajes en este rango                      │
│                                                         │
│  Zona Horaria          [America/Mexico_City ▼]         │
│                                                         │
│                                    [Guardar Cambios]    │
└─────────────────────────────────────────────────────────┘
```

---

## Archivos a Crear/Modificar

### Prioridad 2 (Verdad Financiera)
1. **Nuevo:** `src/hooks/useUnifiedReceipts.ts` - Query combinada de invoices + PayPal transactions
2. **Modificar:** `src/components/dashboard/InvoicesPage.tsx` - Toggle de vista Stripe/PayPal/Todos
3. **Modificar:** `src/hooks/useMetrics.ts` - Restar reembolsos del total
4. **Modificar:** `src/components/dashboard/DashboardHome.tsx` - Mostrar Net Revenue

### Prioridad 3 (Gobernanza)
5. **Nuevo:** `src/components/dashboard/IntegrationsStatusPanel.tsx` - Estado de APIs
6. **Nuevo:** `src/components/dashboard/SystemTogglesPanel.tsx` - Toggles de sistema
7. **Modificar:** `src/components/dashboard/SettingsPage.tsx` - Integrar nuevos paneles
8. **Nueva migración SQL:** Insertar claves por defecto en `system_settings`

---

## Orden de Implementación

1. **Fase 2A** (15 min): Hook `useUnifiedReceipts` + Vista unificada en Facturas
2. **Fase 2B** (10 min): Net Revenue en useMetrics + DashboardHome
3. **Fase 3A** (10 min): Panel de estado de integraciones
4. **Fase 3B** (10 min): Toggles de sistema + migración SQL
5. **Fase 3C** (5 min): Integración en SettingsPage

---

## Resultado Esperado

### Prioridad 2 - Antes vs Después
- **Antes:** Facturas muestra solo Stripe ($735k), Analytics ignora reembolsos
- **Después:** Vista unificada con $1.5M+ (Stripe + PayPal), Net Revenue = Gross - Refunds

### Prioridad 3 - Antes vs Después
- **Antes:** Settings solo tiene GHL webhook, sin control de API keys ni toggles
- **Después:** Panel completo con estado de 5 integraciones, toggles de sistema, y links a Cloud para rotación
