
# Plan: Sistema de Sincronización Robusto "Stage First, Merge Later"

## Objetivo
Crear un sistema donde **primero se descargue toda la data posible de todas las APIs** (GHL, ManyChat, Stripe, PayPal) guardándola en tablas "raw", y **después** (cuando el usuario decida) se haga el merge unificado a la tabla `clients`.

---

## Arquitectura Propuesta

```text
┌─────────────────────────────────────────────────────────────────┐
│                    SYNC COMMAND CENTER                           │
│                  (Panel unificado en el Dashboard)               │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   CONTACTS    │    │   PAYMENTS    │    │   INVOICES    │
│   (CRM Data)  │    │  (Revenue)    │    │   (Billing)   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  FASE 1:      │    │  FASE 1:      │    │  FASE 1:      │
│  STAGING      │    │  STAGING      │    │  STAGING      │
│ (Raw Tables)  │    │ (transactions)│    │ (invoices)    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │     FASE 2:       │
                    │  UNIFY & MERGE    │
                    │  (Background Job) │
                    └───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   TABLA CLIENTS   │
                    │ (Single Source of │
                    │      Truth)       │
                    └───────────────────┘
```

---

## Lo Que Ya Funciona (Estado Actual)

| Fuente | Edge Function | Estado | Tablas Raw |
|--------|--------------|--------|-----------|
| **Stripe Payments** | `fetch-stripe` | ✅ Funciona | → `transactions` (directo) |
| **Stripe Invoices** | `fetch-invoices` | ✅ Funciona | → `invoices` (directo) |
| **Stripe Subscriptions** | `fetch-subscriptions` | ✅ Funciona | → `subscriptions` (directo) |
| **Stripe Customers** | `fetch-customers` | ✅ Funciona | → `clients` (directo) |
| **PayPal Transactions** | `fetch-paypal` | ✅ Funciona | → `transactions` (directo) |
| **GoHighLevel** | `sync-ghl` | ⚠️ Parcial | → `ghl_contacts_raw` ✅ |
| **ManyChat** | `sync-manychat` | ⚠️ Lento | → `manychat_contacts_raw` ✅ |
| **CSV Import** | `process-csv-bulk` | ✅ Funciona | → `csv_imports_raw` ✅ |

---

## Cambios Requeridos

### 1. Mejorar `sync-ghl` para Descarga Masiva Completa

**Problema actual:** Procesa 50 páginas máximo por invocación, puede perderse contactos.

**Solución:**
- Cambiar a paginación completa con checkpoints
- Guardar TODO en `ghl_contacts_raw` sin hacer merge inmediato
- Soportar reanudación automática si se interrumpe

```typescript
// Nuevo flujo sync-ghl
1. Descargar página de contactos de GHL API
2. Guardar TODA la respuesta en ghl_contacts_raw (payload JSONB)
3. Actualizar checkpoint en sync_runs
4. Responder hasMore: true → frontend hace siguiente página
5. Repetir hasta hasMore: false
// NO hacer merge aquí - eso es fase 2
```

### 2. Optimizar `sync-manychat` 

**Problema actual:** Busca email por email (1 request por contacto = muy lento).

**Solución:**
- Cambiar estrategia: exportar lista de subscribers de ManyChat
- O: Usar endpoint de tags para obtener listas masivas
- Guardar en `manychat_contacts_raw` sin merge inmediato

### 3. Crear Panel de Control Unificado

**Nueva página `SyncOrchestrator.tsx`:**

```text
┌─────────────────────────────────────────────────────────┐
│ 🔄 Centro de Sincronización                              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ FASE 1: DESCARGAR DATA                                  │
│ ┌─────────┬─────────┬─────────┬─────────┐              │
│ │ Stripe  │ PayPal  │   GHL   │ManyChat │              │
│ │  ✅ 8k  │  ✅ 2k  │ 🔄 150k │   ⏸️    │              │
│ └─────────┴─────────┴─────────┴─────────┘              │
│                                                          │
│ [Sync Stripe] [Sync PayPal] [Sync GHL] [Sync ManyChat]  │
│                                                          │
│ ──────────────────────────────────────────────────────  │
│                                                          │
│ FASE 2: UNIFICAR IDENTIDADES                            │
│ ┌─────────────────────────────────────────────┐        │
│ │ Raw Data Pendiente:                          │        │
│ │   • ghl_contacts_raw: 217,324 registros     │        │
│ │   • manychat_contacts_raw: 45,000 registros │        │
│ │   • csv_imports_raw: 532,000 registros      │        │
│ └─────────────────────────────────────────────┘        │
│                                                          │
│ [Unificar Todo] ← Ejecuta merge en background           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 4. Crear Edge Function `unify-all-sources`

Nueva función que:
1. Lee de TODAS las tablas raw
2. Aplica prioridades de merge (Email → Phone → IDs externos)
3. Usa `unify_identity` RPC para cada contacto
4. Ejecuta en background con `EdgeRuntime.waitUntil`
5. Reporta progreso en `sync_runs`

### 5. Mejorar `sync-command-center`

Modificar para que:
1. **Solo descargue data** (no haga merge)
2. Reporte cuántos registros hay pendientes de unificar
3. Tenga opción "Unificar Todo" separada

---

## Archivos a Crear/Modificar

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `supabase/functions/sync-ghl/index.ts` | Modificar | Paginación completa, sin merge inmediato |
| `supabase/functions/sync-manychat/index.ts` | Modificar | Estrategia de descarga masiva |
| `supabase/functions/unify-all-sources/index.ts` | **Crear** | Merge unificado de todas las fuentes |
| `src/components/dashboard/SyncOrchestrator.tsx` | **Crear** | Panel de control unificado |
| `supabase/functions/sync-command-center/index.ts` | Modificar | Separar descarga de unificación |

---

## Flujo de Usuario Final

1. **Usuario abre "Centro de Sincronización"**
2. **Hace clic en "Sync All"** → Descarga toda la data de APIs
   - Stripe: Transacciones, Facturas, Suscripciones, Clientes
   - PayPal: Transacciones, Suscripciones
   - GHL: Todos los contactos → `ghl_contacts_raw`
   - ManyChat: Todos los subscribers → `manychat_contacts_raw`
3. **Ve el progreso en tiempo real** vía `sync_runs`
4. **Cuando termina, ve contadores de "pendientes de unificar"**
5. **Hace clic en "Unificar Todo"** → Merge en background
6. **Todos los contactos aparecen en `clients` correctamente vinculados**

---

## Detalles Técnicos

### Prioridades de Merge (Identity Resolution)
```text
1. stripe_customer_id → Identificador más confiable para pagos
2. email → Identificador universal
3. phone_e164 → Respaldo si no hay email
4. ghl_contact_id → Para contactos solo de GHL
5. manychat_subscriber_id → Para contactos solo de ManyChat
```

### Manejo de Conflictos
- Si email de GHL ≠ email de ManyChat para mismo teléfono → Guardar en `merge_conflicts`
- UI para resolución manual de conflictos

### Rate Limiting por API
| API | Límite | Delay entre páginas |
|-----|--------|---------------------|
| Stripe | 100 req/s | 100ms |
| PayPal | 30 req/s | 200ms |
| GHL | 10 req/s | 150ms |
| ManyChat | 10 req/s | 200ms |

---

## Estimación de Trabajo

| Tarea | Complejidad | Tiempo Estimado |
|-------|-------------|-----------------|
| Modificar sync-ghl | Media | 45 min |
| Modificar sync-manychat | Alta | 60 min |
| Crear unify-all-sources | Alta | 90 min |
| Crear SyncOrchestrator UI | Media | 60 min |
| Modificar sync-command-center | Baja | 30 min |
| **Total** | | **~5 horas** |

---

## Beneficios del Nuevo Sistema

1. **Sin pérdida de data**: Todo se guarda primero, merge después
2. **Reanudable**: Si se interrumpe, continúa desde checkpoint
3. **Visible**: Panel muestra exactamente qué hay pendiente
4. **Robusto**: Merge en background no bloquea la UI
5. **Escalable**: Soporta 500k+ registros sin problemas
