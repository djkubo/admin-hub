

# Plan: Mejoras Avanzadas de Smart Recovery

## Resumen Ejecutivo

Implementaremos 3 mejoras críticas para maximizar la recuperación de ingresos:

1. **Notificaciones Pre-Cobro**: SMS/WhatsApp 24-48h antes de reintentar
2. **Reintentos Automáticos Programados**: Cola inteligente para facturas con "insufficient funds"
3. **Portal de Actualización de Tarjeta**: Link único por SMS para que clientes actualicen su método de pago

---

## 1. Notificaciones Pre-Cobro (WhatsApp/SMS)

### Objetivo
Dar al cliente 24-48 horas para agregar fondos antes de reintentar el cobro, aumentando la tasa de éxito.

### Flujo del Sistema
```text
┌─────────────────────────────────────────────────────────────────┐
│                   FLUJO DE NOTIFICACIONES                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   invoice.payment_failed (webhook)                              │
│         │                                                       │
│         ▼                                                       │
│   1. Detectar error "insufficient_funds" o "card_declined"      │
│         │                                                       │
│         ▼                                                       │
│   2. Agregar a recovery_queue con retry_at = now + 48h          │
│         │                                                       │
│         ▼                                                       │
│   3. Enviar notificación INMEDIATA (WhatsApp/SMS)               │
│      "Tu pago de $X no se procesó. Link para actualizar tarjeta"│
│         │                                                       │
│         ▼                                                       │
│   4. Cron job procesa cola cuando retry_at llega                │
│         │                                                       │
│         ▼                                                       │
│   5. Smart Recovery reintenta cobro                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Cambios Requeridos

**Nueva tabla: `recovery_queue`**
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID | Primary key |
| invoice_id | TEXT | Stripe invoice ID |
| client_id | UUID | Referencia a clients |
| stripe_customer_id | TEXT | Customer de Stripe |
| amount_due | INTEGER | Monto en centavos |
| failure_reason | TEXT | Código del error |
| retry_at | TIMESTAMPTZ | Cuándo reintentar |
| notification_sent_at | TIMESTAMPTZ | Cuándo se envió notificación |
| status | TEXT | pending, notified, retrying, recovered, failed |
| attempt_count | INTEGER | Número de intentos |
| portal_link | TEXT | Link único para actualizar tarjeta |
| created_at | TIMESTAMPTZ | Fecha de creación |

**Modificar: `stripe-webhook/index.ts`**
- En `handleInvoicePaymentFailed`: Agregar lógica para insertar en `recovery_queue`
- Llamar a `send-sms` con template de notificación pre-cobro

---

## 2. Reintentos Automáticos Programados

### Objetivo
Crear un sistema de cola que reintente facturas con "insufficient funds" automáticamente después de 3-5 días.

### Nueva Edge Function: `process-recovery-queue`

**Funcionalidad:**
1. Consultar facturas en `recovery_queue` con `status = 'notified'` y `retry_at <= now()`
2. Para cada factura:
   - Actualizar status a `retrying`
   - Llamar a Stripe API para reintentar cobro
   - Si éxito: Marcar como `recovered`, eliminar de cola
   - Si falla: Incrementar `attempt_count`
     - Si `attempt_count >= 3`: Marcar como `failed`
     - Si no: Programar nuevo `retry_at` en +3 días

**Configuración de reintentos:**
| Intento | Delay | Acción |
|---------|-------|--------|
| 1 | 48 horas | Notificación + primer reintento |
| 2 | +3 días | Segundo reintento |
| 3 | +5 días | Último intento + notificación final |

---

## 3. Portal de Actualización de Tarjeta

### Objetivo
Generar un link único que los clientes pueden usar para actualizar su método de pago directamente.

### Nueva Edge Function: `generate-payment-link`

**Flujo:**
```text
┌─────────────────────────────────────────────────────────────────┐
│                   PORTAL DE ACTUALIZACIÓN                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   Cliente recibe SMS:                                           │
│   "Pago fallido. Actualiza tu tarjeta aquí: [LINK]"            │
│         │                                                       │
│         ▼                                                       │
│   generate-payment-link                                         │
│         │                                                       │
│         ├─► Genera token único (UUID)                          │
│         ├─► Guarda en payment_links (token, client_id, expires)│
│         └─► Retorna URL: /update-card?token=xxx                │
│                                                                 │
│   Cliente hace click                                            │
│         │                                                       │
│         ▼                                                       │
│   Stripe Billing Portal Session                                 │
│   (ya existe: create-portal-session)                           │
│         │                                                       │
│         ▼                                                       │
│   Cliente actualiza tarjeta en portal de Stripe                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Nueva tabla: `payment_links`** (ya existe en el schema)
| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | UUID | Primary key |
| token | TEXT | Token único para el link |
| client_id | UUID | Cliente |
| stripe_customer_id | TEXT | Customer de Stripe |
| invoice_id | TEXT | Factura relacionada |
| expires_at | TIMESTAMPTZ | Expiración (7 días) |
| used_at | TIMESTAMPTZ | Cuándo se usó |
| created_at | TIMESTAMPTZ | Fecha de creación |

### Nueva Página: `/update-card`

**Funcionalidad:**
1. Recibir token de URL
2. Validar token en `payment_links`
3. Si válido y no expirado:
   - Llamar a `create-portal-session` con el `stripe_customer_id`
   - Redirigir a Stripe Billing Portal
4. Si inválido o expirado: Mostrar error amigable

---

## Archivos a Crear/Modificar

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `supabase/functions/process-recovery-queue/index.ts` | CREAR | Procesa cola de reintentos |
| `supabase/functions/generate-payment-link/index.ts` | CREAR | Genera links de actualización |
| `supabase/functions/stripe-webhook/index.ts` | MODIFICAR | Agregar a cola en payment_failed |
| `supabase/config.toml` | MODIFICAR | Registrar nuevas funciones |
| `src/pages/UpdateCard.tsx` | CREAR | Página para actualizar tarjeta |
| `src/App.tsx` | MODIFICAR | Agregar ruta /update-card |
| **Migración SQL** | CREAR | Tabla recovery_queue |

---

## Migración SQL

```sql
-- Tabla para cola de recuperación
CREATE TABLE IF NOT EXISTS recovery_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id TEXT NOT NULL,
  client_id UUID REFERENCES clients(id),
  stripe_customer_id TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  amount_due INTEGER NOT NULL,
  currency TEXT DEFAULT 'usd',
  failure_reason TEXT,
  failure_message TEXT,
  retry_at TIMESTAMPTZ NOT NULL,
  notification_sent_at TIMESTAMPTZ,
  notification_channel TEXT, -- 'sms' | 'whatsapp' | 'email'
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'retrying', 'recovered', 'failed', 'cancelled')),
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  portal_link_token TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  recovered_at TIMESTAMPTZ,
  recovered_amount INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(invoice_id)
);

-- Índices para consultas eficientes
CREATE INDEX idx_recovery_queue_status_retry ON recovery_queue(status, retry_at) 
  WHERE status IN ('pending', 'notified');
CREATE INDEX idx_recovery_queue_client ON recovery_queue(client_id);
CREATE INDEX idx_recovery_queue_invoice ON recovery_queue(invoice_id);

-- Tabla para links de pago (si no existe)
CREATE TABLE IF NOT EXISTS payment_update_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  client_id UUID REFERENCES clients(id),
  stripe_customer_id TEXT NOT NULL,
  invoice_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_payment_links_token ON payment_update_links(token);

-- RLS políticas
ALTER TABLE recovery_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access recovery_queue" ON recovery_queue
  FOR ALL USING (public.is_admin());

ALTER TABLE payment_update_links ENABLE ROW LEVEL SECURITY;  
CREATE POLICY "Admin full access payment_links" ON payment_update_links
  FOR ALL USING (public.is_admin());
```

---

## Templates de Mensajes

### Template 1: Notificación Inicial (48h antes)
```
Hola {{nombre}} 👋

Tu pago de ${{monto}} no se procesó correctamente.

Para evitar la suspensión de tu servicio, actualiza tu método de pago aquí:
{{link}}

¿Necesitas ayuda? Responde a este mensaje.
```

### Template 2: Recordatorio (24h antes del reintento)
```
⚠️ {{nombre}}, mañana intentaremos cobrar ${{monto}} nuevamente.

Si tu tarjeta no tiene fondos, puedes actualizarla ahora:
{{link}}

Evita la suspensión de tu servicio.
```

### Template 3: Último Aviso (después del 3er fallo)
```
🚨 ÚLTIMO AVISO: {{nombre}}

Tu servicio será suspendido por falta de pago (${{monto}}).

Actualiza tu tarjeta AHORA:
{{link}}

O contáctanos urgentemente.
```

---

## Flujo Completo Integrado

```text
┌─────────────────────────────────────────────────────────────────┐
│                FLUJO COMPLETO DE RECUPERACIÓN                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Día 0: Pago falla                                               │
│   │                                                             │
│   ├─► 1. stripe-webhook detecta invoice.payment_failed         │
│   ├─► 2. Inserta en recovery_queue (retry_at = +48h)           │
│   ├─► 3. Genera portal_link via generate-payment-link          │
│   └─► 4. Envía SMS/WA con Template 1 + link                    │
│                                                                 │
│ Día 2: Primer reintento                                         │
│   │                                                             │
│   ├─► 5. process-recovery-queue detecta retry_at alcanzado     │
│   ├─► 6. Intenta cobrar via Stripe API                         │
│   │      └─► Si ÉXITO: Marcar recovered, enviar confirmación   │
│   │      └─► Si FALLA: Programar retry_at = +3 días            │
│   └─► 7. Enviar SMS con Template 2                             │
│                                                                 │
│ Día 5: Segundo reintento                                        │
│   │                                                             │
│   └─► (Mismo proceso)                                           │
│                                                                 │
│ Día 10: Tercer y último reintento                               │
│   │                                                             │
│   ├─► 8. Intenta cobrar                                        │
│   │      └─► Si ÉXITO: Recovered                               │
│   │      └─► Si FALLA: Marcar como failed definitivo           │
│   └─► 9. Enviar SMS con Template 3 (último aviso)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Cronograma de Implementación

| Paso | Descripción | Prioridad |
|------|-------------|-----------|
| 1 | Crear migración SQL (recovery_queue, payment_update_links) | Alta |
| 2 | Crear `generate-payment-link` Edge Function | Alta |
| 3 | Modificar `stripe-webhook` para insertar en cola | Alta |
| 4 | Crear página `/update-card` frontend | Alta |
| 5 | Crear `process-recovery-queue` Edge Function | Alta |
| 6 | Agregar templates de notificación | Media |
| 7 | Integrar con send-sms para envíos automáticos | Media |

---

## Beneficios Esperados

| Métrica | Antes | Después Esperado |
|---------|-------|------------------|
| Tasa de recuperación | ~5% | ~25-35% |
| Tiempo promedio de recuperación | N/A | 48-72 horas |
| Clientes que actualizan tarjeta | 0% | ~15-20% |
| Churn involuntario | Alto | Reducido 30-40% |

