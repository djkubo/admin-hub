
# Plan: Sistema de Importación CSV con Staging y Vista Inmediata

## Diagnóstico del Problema

### Por qué fallan los CSV actualmente:
1. **Todo-en-uno**: El sistema intenta parsear CSV + detectar duplicados + hacer merge + insertar en una sola operación
2. **Sin tolerancia a fallos**: Si una fila falla, puede abortar todo el proceso
3. **Sin visibilidad**: Los contactos NO aparecen hasta que todo el proceso termine exitosamente
4. **Merge agresivo**: Intenta unificar identidades durante la carga, generando conflictos (ya hay 38,938 en `merge_conflicts`)

### Tu idea es la solución correcta:
- **Fase 1 - Staging**: Guardar datos "tal cual" → Visibles inmediatamente, sin errores
- **Fase 2 - Merge**: Unificación en background → Controlada, sin bloquear al usuario

---

## Arquitectura Propuesta

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         FLUJO DE IMPORTACIÓN                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [Usuario sube CSV]                                                  │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────────┐                                           │
│  │  FASE 1: STAGING     │ ← Rápido, sin errores                    │
│  │  • Guardar en        │                                           │
│  │    csv_imports_raw   │                                           │
│  │  • Sin validación    │                                           │
│  │  • Retorna "éxito"   │                                           │
│  └──────────┬───────────┘                                           │
│             │                                                        │
│             ▼                                                        │
│  [CONTACTOS VISIBLES] ← El usuario los ve en la UI inmediatamente   │
│             │                                                        │
│             ▼                                                        │
│  ┌──────────────────────┐                                           │
│  │  FASE 2: MERGE       │ ← Background, con EdgeRuntime.waitUntil  │
│  │  • Procesar staging  │                                           │
│  │  • Detectar dups     │                                           │
│  │  • Unificar en       │                                           │
│  │    clients/trans     │                                           │
│  └──────────────────────┘                                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Cambios a Implementar

### 1. Crear tabla `csv_imports_raw` (staging universal)

Nueva tabla para almacenar TODAS las filas de CSV tal cual llegan:

```sql
CREATE TABLE public.csv_imports_raw (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL,                    -- Agrupa todas las filas de un mismo archivo
  row_number INT NOT NULL,                    -- Posición en el CSV original
  email TEXT,                                  -- Email extraído (para búsquedas rápidas)
  phone TEXT,                                  -- Teléfono extraído
  source_type TEXT NOT NULL,                  -- 'master', 'ghl', 'stripe', 'paypal', etc.
  raw_data JSONB NOT NULL,                    -- Fila completa como objeto JSON
  processing_status TEXT DEFAULT 'pending',   -- 'pending', 'merged', 'conflict', 'error'
  merged_client_id UUID,                       -- Si se unificó, referencia al cliente
  error_message TEXT,                          -- Si hubo error en el merge
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Índices para consultas rápidas
CREATE INDEX idx_csv_imports_raw_import ON csv_imports_raw(import_id);
CREATE INDEX idx_csv_imports_raw_email ON csv_imports_raw(email);
CREATE INDEX idx_csv_imports_raw_status ON csv_imports_raw(processing_status);
CREATE INDEX idx_csv_imports_raw_created ON csv_imports_raw(created_at DESC);

-- Tabla para trackear imports
CREATE TABLE public.csv_import_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  filename TEXT,
  source_type TEXT,
  total_rows INT DEFAULT 0,
  rows_staged INT DEFAULT 0,
  rows_merged INT DEFAULT 0,
  rows_conflict INT DEFAULT 0,
  rows_error INT DEFAULT 0,
  status TEXT DEFAULT 'staging',  -- 'staging', 'processing', 'completed', 'failed'
  started_at TIMESTAMPTZ DEFAULT now(),
  staged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT
);
```

### 2. Modificar Edge Function `process-csv-bulk`

Cambiar para usar arquitectura de 2 fases:

**Fase 1 (Síncrona):**
- Crear registro en `csv_import_runs`
- Parsear CSV y extraer email/phone básico de cada fila
- Insertar TODO en `csv_imports_raw` en batches de 1000
- Retornar inmediatamente con `import_id` y conteo

**Fase 2 (Background con waitUntil):**
- Procesar filas de `csv_imports_raw` por `import_id`
- Ejecutar lógica de merge existente
- Actualizar `processing_status` en cada fila
- Si hay conflicto → guardar en `merge_conflicts`
- Actualizar progreso en `csv_import_runs`

### 3. Crear vista `clients_with_staging`

Vista que combina clientes unificados + contactos en staging:

```sql
CREATE VIEW public.clients_with_staging AS
  -- Clientes ya unificados
  SELECT 
    id, email, full_name, phone, lifecycle_stage, total_spend,
    ghl_contact_id, stripe_customer_id,
    'unified' as status,
    created_at
  FROM clients
  
  UNION ALL
  
  -- Contactos en staging pendientes de merge
  SELECT 
    csv_imports_raw.id,
    csv_imports_raw.email,
    csv_imports_raw.raw_data->>'full_name' as full_name,
    csv_imports_raw.phone,
    'PENDING' as lifecycle_stage,
    0 as total_spend,
    csv_imports_raw.raw_data->>'ghl_contact_id' as ghl_contact_id,
    csv_imports_raw.raw_data->>'stripe_customer_id' as stripe_customer_id,
    csv_imports_raw.processing_status as status,
    csv_imports_raw.created_at
  FROM csv_imports_raw
  WHERE processing_status = 'pending';
```

### 4. Actualizar Frontend `CSVUploader.tsx`

Cambiar flujo para:
1. Mostrar progreso de "Subiendo a staging..."
2. Cuando staging complete → Mostrar "✓ X contactos importados"
3. Iniciar merge en background
4. Mostrar progreso del merge separadamente
5. Permitir ver contactos ANTES de que el merge termine

### 5. Crear componente `StagingContactsPanel`

Nuevo panel que muestra:
- Contactos en staging pendientes de merge
- Progreso del merge actual
- Conflictos detectados
- Opción de "forzar merge" o "ignorar duplicado"

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `supabase/migrations/` | Nueva migración para `csv_imports_raw` y `csv_import_runs` |
| `supabase/functions/process-csv-bulk/index.ts` | Refactorizar a 2 fases (staging + merge en background) |
| `src/components/dashboard/CSVUploader.tsx` | Actualizar UI para mostrar staging y merge por separado |
| `src/hooks/useClients.ts` | Usar vista `clients_with_staging` para mostrar contactos inmediatamente |
| `src/components/dashboard/StagingContactsPanel.tsx` | **NUEVO** - Panel para ver/gestionar staging |

---

## Beneficios de Esta Arquitectura

1. **Sin errores de carga**: El staging NUNCA falla (solo guarda JSON)
2. **Visibilidad inmediata**: Contactos aparecen en segundos
3. **Merge controlado**: Se procesa en background, sin bloquear UI
4. **Recuperación de errores**: Si el merge falla, los datos no se pierden
5. **Gestión de conflictos**: El usuario puede resolver duplicados manualmente
6. **Escalabilidad**: Puede manejar archivos de cualquier tamaño

---

## Sección Técnica

### Flujo de Datos Detallado

```text
CSV (100MB, 200k filas)
    │
    ▼
[CSVUploader.tsx]
    │ splitCSVIntoChunks(4MB each)
    │
    ▼
[process-csv-bulk] ─────────────────────────────────────┐
    │                                                    │
    │ FASE 1 (Síncrona, 5-10s):                         │
    │   1. Crear csv_import_runs                         │
    │   2. Parsear headers                               │
    │   3. Para cada fila:                              │
    │      - Extraer email, phone (sin validar)         │
    │      - raw_data = fila completa como JSON         │
    │   4. INSERT batch en csv_imports_raw (1000/batch) │
    │   5. RETURN { ok: true, import_id, staged: N }    │
    │                                                    │
    │ EdgeRuntime.waitUntil(fase2) ──────────────────────┘
    │                                                    │
    ▼                                                    ▼
[Usuario ve contactos]                        [FASE 2 Background]
    │                                           │
    │                                           │ Procesar csv_imports_raw:
    │                                           │   - Buscar cliente por email
    │                                           │   - Si existe → update
    │                                           │   - Si no existe → insert
    │                                           │   - Si conflicto → merge_conflicts
    │                                           │   - Actualizar processing_status
    │                                           │
    │                                           ▼
    │                                    [Merge completo]
    │                                           │
    └───────────────────────────────────────────┘
                        │
                        ▼
            [Contactos unificados en clients]
```

### Estructura de `raw_data` en staging

Para un Master CSV, cada fila se guarda así:

```json
{
  "email": "usuario@ejemplo.com",
  "auto_master_name": "Juan Pérez",
  "auto_master_phone": "+525512345678",
  "auto_total_spend": "1500.00",
  "cnt_contact_id": "abc123",
  "cnt_first_name": "Juan",
  "cnt_tags": "VIP,Cliente",
  "st_id": "ch_xyz789",
  "st_amount": "500.00",
  "pp_id_de_transaccion": "TX123456"
}
```

### Consulta para mostrar contactos (incluyendo staging)

```typescript
// En useClients.ts
const { data: clients } = await supabase
  .from('clients_with_staging')
  .select('*')
  .order('created_at', { ascending: false })
  .limit(1000);
```

---

## Resumen Ejecutivo

| Antes | Después |
|-------|---------|
| CSV → Merge directo → Errores frecuentes | CSV → Staging → Merge en background |
| Contactos invisibles hasta terminar | Contactos visibles inmediatamente |
| Fallos bloquean todo el proceso | Fallos aislados por fila |
| Sin recuperación de errores | Datos preservados en staging |
| Sin visibilidad de conflictos | Panel para gestionar duplicados |
