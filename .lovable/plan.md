

# Plan: Actualización del Motor de IA a GPT-5.2 / Lovable AI

## Resumen del Análisis

Se escanearon todas las Edge Functions en `supabase/functions/`. Se identificaron **2 funciones que usan IA**:

| Función | Motor Actual | API Actual | Temperatura | Estado |
|---------|-------------|------------|-------------|--------|
| `analyze-business` | `gpt-4o` | OpenAI directo | 0.7 | Requiere migración |
| `generate-chat-summary` | `gemini-2.5-flash` | Lovable AI Gateway | 0.7 | Ya modernizado |

Las demás funciones (`vrp-brain-api`, `execute-flow`, `automated-dunning`, `recover-revenue`, `send-broadcast`, etc.) **no usan modelos de IA** - son funciones de integración, procesamiento de datos o webhooks.

---

## Cambios a Implementar

### 1. Migrar `analyze-business` a Lovable AI + GPT-5.2

Cambios en el archivo `supabase/functions/analyze-business/index.ts`:

**Antes:**
```typescript
const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
// ...
const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
  headers: { 'Authorization': `Bearer ${openaiApiKey}` },
  body: JSON.stringify({
    model: 'gpt-4o',
    temperature: 0.7,
    // ...
  })
});
```

**Después:**
```typescript
const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
// ...
const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
  headers: { 'Authorization': `Bearer ${lovableApiKey}` },
  body: JSON.stringify({
    model: 'openai/gpt-5.2',
    temperature: 0.2,  // Más preciso para análisis de datos
    // ...
  })
});
```

### 2. Actualizar `generate-chat-summary` a GPT-5.2

Esta función ya usa Lovable AI Gateway. Solo cambiaremos el modelo:

**Antes:**
```typescript
model: "google/gemini-2.5-flash"
```

**Después:**
```typescript
model: "openai/gpt-5.2"
```

### 3. Ajustar Temperaturas según Función

| Función | Propósito | Temperatura Recomendada |
|---------|-----------|------------------------|
| `analyze-business` | Análisis de datos/métricas | 0.2 (preciso) |
| `generate-chat-summary` | Inteligencia de ventas | 0.3 (balance precisión/creatividad) |

### 4. Eliminar instrucciones manuales de CoT

El modelo GPT-5.2 razona mejor de forma nativa. Se eliminarán instrucciones como:
- "piensa paso a paso"
- "analiza primero... luego..."

Los prompts se simplificarán manteniendo solo las instrucciones esenciales.

---

## Detalle Técnico de Cambios por Archivo

### `supabase/functions/analyze-business/index.ts`

| Línea | Cambio |
|-------|--------|
| 75 | Cambiar `OPENAI_API_KEY` → `LOVABLE_API_KEY` |
| 77-79 | Actualizar mensaje de error |
| 337 | Cambiar URL de API a Lovable Gateway |
| 340 | Cambiar header de autorización |
| 344 | Cambiar modelo a `openai/gpt-5.2` |
| 352 | Cambiar temperatura a `0.2` |
| 357-371 | Agregar manejo de errores 402 (Payment Required) |

### `supabase/functions/generate-chat-summary/index.ts`

| Línea | Cambio |
|-------|--------|
| 358 | Cambiar modelo a `openai/gpt-5.2` |
| 365 | Cambiar temperatura a `0.3` |
| 368-375 | Agregar manejo de error 402 |

---

## Beneficios Esperados

1. **Análisis más profundo**: GPT-5.2 tiene razonamiento superior para métricas complejas
2. **Mejor detección de patrones**: En análisis de ventas y objeciones
3. **Respuestas más estructuradas**: Mejor formato JSON sin errores
4. **Consistencia**: Ambas funciones usarán el mismo proveedor (Lovable AI)
5. **Sin costo adicional de API key**: LOVABLE_API_KEY ya está configurado

---

## Verificación de Secretos

| Secret | Estado | Uso |
|--------|--------|-----|
| `LOVABLE_API_KEY` | Configurado | Será usado para ambas funciones |
| `OPENAI_API_KEY` | Configurado | Ya no será necesario para IA (puede eliminarse) |

---

## Funciones Sin IA (No requieren cambios)

Las siguientes funciones fueron analizadas y NO contienen llamadas a modelos de IA:

- `vrp-brain-api` - API Gateway para Python backend
- `execute-flow` - Ejecutor de flujos de automatización
- `automated-dunning` - Cobranza automática
- `recover-revenue` - Recuperación de pagos
- `send-broadcast` - Envío de difusiones
- `notify-ghl` - Notificaciones GoHighLevel
- `send-sms` - Envío de SMS
- Todas las demás funciones de sync, webhooks e integraciones

---

## Archivos a Modificar

```text
supabase/functions/
├── analyze-business/
│   └── index.ts         (migrar OpenAI → Lovable AI + gpt-5.2)
└── generate-chat-summary/
    └── index.ts         (actualizar modelo a gpt-5.2)
```

**Total: 2 archivos a modificar**

