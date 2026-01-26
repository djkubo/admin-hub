
# Plan Definitivo: Procesamiento de CSV Sin Timeouts

## Diagnóstico Final

### Por qué ninguna optimización funciona:
1. **Edge Functions tienen límite DURO de 60 segundos** - No hay forma de extender esto en Lovable Cloud
2. Con 146k filas, incluso con chunks de 1MB (~2000 filas), cada chunk requiere:
   - Parsear CSV → 5-10s
   - Insertar en staging → 10-20s
   - El servidor mata la función antes de responder → **"shutdown"**
3. Los logs muestran **6 shutdowns consecutivos** = el servidor mata la función antes de terminar

### Soluciones Reales Disponibles:

| Opción | Pros | Contras |
|--------|------|---------|
| **A. Script Local (Node.js)** | Sin límites, ya existe | Requiere terminal, menos conveniente |
| **B. Python Backend (Render)** | Ya tienes servidor, sin límites | Requiere endpoint nuevo |
| **C. Procesamiento Ultra-Micro** | Funciona desde browser | Más lento, muchos requests |

---

## Solución Recomendada: Opción A + C Híbrida

### Para archivos GIGANTES (>50k filas): Script Local
Ya tienes `import-all-csvs.js` que funciona perfectamente. Solo necesitas ejecutarlo desde terminal.

### Para archivos medianos (5k-50k filas): Micro-chunks desde browser
Reducir chunks a **200KB** (~500 filas) para garantizar que SIEMPRE terminen en <30 segundos.

---

## Implementación

### 1. Optimizar Edge Function para micro-chunks

Cambios en `process-csv-bulk`:
- Eliminar toda lógica de merge del request síncrono
- Solo hacer INSERT directo sin validación
- Responder en <5 segundos por chunk

```
ANTES: 1MB chunk → 2000 filas → parsear + staging + merge → timeout
AHORA: 200KB chunk → 500 filas → solo INSERT raw → <10 segundos
```

### 2. Actualizar CSVUploader para micro-chunks

```typescript
// De 1MB a 200KB
const MAX_CHUNK_SIZE = 200 * 1024; // 200KB = ~500 filas

// Máximo 5 chunks paralelos para no saturar
const PARALLEL_CHUNKS = 5;
```

### 3. Simplificar staging al mínimo

La Edge Function solo hace:
1. Recibir chunk de texto CSV
2. Parsear a JSON simple
3. INSERT directo en `csv_imports_raw`
4. Retornar `{ ok: true, rows: N }`

NO hace:
- Validación de emails
- Normalización de teléfonos
- Detección de duplicados
- Merge con clientes existentes

### 4. Crear proceso de Merge separado

Nueva Edge Function `merge-staged-imports`:
- Se ejecuta DESPUÉS de que todo el staging complete
- Procesa en background con `EdgeRuntime.waitUntil`
- Puede tomar varios minutos sin bloquear nada

---

## Flujo Final

```
┌─────────────────────────────────────────────────────────┐
│              SUBIDA DE CSV GRANDE                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [CSV 146k filas] ─────────────────────────────────────│
│         │                                               │
│         ▼                                               │
│  [Frontend divide en ~300 chunks de 200KB]              │
│         │                                               │
│         ▼ (5 chunks paralelos)                          │
│  ┌──────────────────────┐                              │
│  │ process-csv-bulk     │                              │
│  │ • Parsear JSON       │ ← 3-5 segundos por chunk     │
│  │ • INSERT directo     │                              │
│  └──────────────────────┘                              │
│         │                                               │
│         ▼ (después de todos los chunks)                │
│  [146k filas en csv_imports_raw] ← VISIBLES EN UI      │
│         │                                               │
│         ▼                                               │
│  ┌──────────────────────┐                              │
│  │ merge-staged-imports │ ← Edge Function separada     │
│  │ • Procesa staging    │                              │
│  │ • Unifica clientes   │                              │
│  │ • Background: mins   │                              │
│  └──────────────────────┘                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `supabase/functions/process-csv-bulk/index.ts` | Simplificar a solo INSERT directo, sin merge |
| `src/components/dashboard/CSVUploader.tsx` | Reducir chunk a 200KB, 5 paralelos |
| `supabase/functions/merge-staged-imports/index.ts` | **NUEVA** - Merge en background |
| `src/components/dashboard/StagingContactsPanel.tsx` | Agregar botón "Iniciar Merge" |

---

## Beneficios

1. **Nunca timeout**: Cada chunk se procesa en <10s
2. **Visibilidad inmediata**: Contactos aparecen mientras suben
3. **Escalable**: Funciona con 1M+ filas
4. **Sin dependencias externas**: Todo desde el browser

---

## Alternativa: Script Local (Ya existe)

Si quieres subir AHORA sin esperar, ya tienes el script:

```bash
# 1. Exportar la Service Role Key (desde Lovable Cloud → Settings → Environment Variables)
export SUPABASE_SERVICE_ROLE_KEY="tu-key"

# 2. Ejecutar el script
node import-all-csvs.js
```

Este script NO tiene límites de tiempo y puede procesar millones de filas.

---

## Resumen Ejecutivo

El problema NO es el código, es el **límite de 60 segundos** de Edge Functions. La solución es:

1. **Dividir más pequeño**: 200KB chunks (~500 filas) garantizan respuesta en <10s
2. **Separar staging de merge**: Guardar rápido, procesar después
3. **Para archivos enormes**: Usar el script local que ya tienes

Con estos cambios, podrás subir tus 146k contactos sin errores ni timeouts.
