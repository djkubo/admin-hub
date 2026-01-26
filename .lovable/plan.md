
# Plan: Corrección del Sistema de Carga de CSV

## Problema Identificado

El sistema falla al cargar archivos CSV porque:

1. **Límite de payload**: Los archivos grandes (>50MB) exceden el límite de las Edge Functions
2. **Timeout de navegador**: El navegador aborta la solicitud si tarda >60 segundos
3. **Headers no coinciden**: Los headers del CSV maestro tienen caracteres especiales que no se normalizan correctamente

## Cambios a Implementar

### Cambio 1: Agregar Chunking Automático en CSVUploader

Dividir archivos grandes en partes manejables de 5MB cada una y procesarlas secuencialmente.

**Archivo**: `src/components/dashboard/CSVUploader.tsx`

```text
Lógica:
1. Si archivo > 5MB → dividir en chunks por número de líneas
2. Enviar cada chunk por separado con flag "isChunk: true, chunkIndex: N"
3. Edge Function procesa cada chunk independientemente
4. Agregar barra de progreso visual
```

### Cambio 2: Normalizar Headers del CSV Maestro

Limpiar caracteres especiales, puntos, acentos y paréntesis de los headers antes de buscar coincidencias.

**Archivo**: `supabase/functions/process-csv-bulk/index.ts`

```typescript
// Antes de buscar columnas, normalizar headers
const normalizeHeader = (h: string) => 
  h.toLowerCase()
   .replace(/\./g, '')           // Quitar puntos
   .replace(/[áàä]/g, 'a')       // Normalizar acentos
   .replace(/[éèë]/g, 'e')
   .replace(/[íìï]/g, 'i')
   .replace(/[óòö]/g, 'o')
   .replace(/[úùü]/g, 'u')
   .replace(/ñ/g, 'n')
   .replace(/\s+/g, ' ')         // Espacios múltiples → uno
   .trim();
```

### Cambio 3: Mejorar Detección de Columnas del CSV Maestro

El código actual busca columnas específicas como `pp_id de transacción` pero el CSV tiene `PP_Id. de transacción`. Necesitamos búsqueda flexible.

**Archivo**: `supabase/functions/process-csv-bulk/index.ts`

```typescript
// En lugar de búsqueda exacta:
const ppTxIdIdx = colMap['pp_id de transacción'] ?? -1;

// Usar búsqueda parcial:
const ppTxIdIdx = findColumnIndex(headers, ['pp_id', 'transaccion', 'transaction']);
```

### Cambio 4: Agregar Endpoint de Streaming para Archivos Muy Grandes

Para archivos >50MB, usar un enfoque diferente donde el navegador envía el archivo en partes pequeñas.

**Archivo**: `src/components/dashboard/CSVUploader.tsx`

```typescript
// Si archivo > 50MB:
// 1. Dividir en chunks de 5MB (aproximadamente 50k-100k líneas)
// 2. Enviar chunk 1 con { isFirstChunk: true, totalChunks: N }
// 3. Enviar chunks 2-N con { chunkIndex: X, sessionId: "abc" }
// 4. Edge Function acumula y procesa al final
```

### Cambio 5: Barra de Progreso Visual

Mostrar al usuario el progreso real de la carga y procesamiento.

**Archivo**: `src/components/dashboard/CSVUploader.tsx`

```text
- Añadir state para progreso: uploadProgress, processingProgress
- Mostrar: "Cargando chunk 3/10 (30%)"
- Mostrar: "Procesando 50,000 / 200,000 filas"
```

### Cambio 6: Manejo de Errores Más Claro

Cuando falla la carga, explicar claramente qué pasó y qué puede hacer el usuario.

**Archivo**: `src/components/dashboard/CSVUploader.tsx`

```typescript
if (error.message.includes('Failed to fetch') || error.message.includes('Failed to send')) {
  toast.error(
    'El archivo es muy grande. Intentando dividirlo automáticamente...', 
    { duration: 5000 }
  );
  // Intentar chunking automático
}
```

---

## Archivos a Modificar

1. `src/components/dashboard/CSVUploader.tsx`
   - Agregar chunking automático para archivos >5MB
   - Barra de progreso visual
   - Mejor manejo de errores

2. `supabase/functions/process-csv-bulk/index.ts`
   - Normalizar headers (quitar puntos, acentos)
   - Búsqueda flexible de columnas
   - Soporte para procesamiento en chunks

---

## Sección Técnica

### Límites Conocidos de Edge Functions
- **Payload máximo**: ~50MB por solicitud
- **Timeout**: 60 segundos (puede extenderse a 120s)
- **Memoria**: 150MB por función

### Estrategia de Chunking
```text
Archivo de 100MB con 500,000 líneas:
→ Dividir en 10 chunks de ~50,000 líneas cada uno
→ Cada chunk es ~10MB
→ Procesar secuencialmente con 500ms de pausa entre chunks
→ Acumular resultados y mostrar totales al final
```

### Normalización de Headers (Tu CSV vs Código)

| Tu CSV | Código busca | Solución |
|--------|--------------|----------|
| `PP_Id. de transacción` | `pp_id de transaccion` | Normalizar quitando puntos |
| `ST_Created date (UTC)` | `st_created date (utc)` | Ya coincide ✅ |
| `CNT_Contact Id` | `cnt_contact id` | Ya coincide ✅ |
| `PP_Correo electrónico del destinatario` | `pp_correo electronico` | Normalizar acentos |

### Flujo de Procesamiento Mejorado
```text
1. Usuario selecciona CSV
2. Detectar tamaño del archivo
3. Si < 5MB → enviar directo
4. Si 5-50MB → dividir en chunks y enviar secuencialmente
5. Si > 50MB → mostrar advertencia y ofrecer dividir manualmente
6. Mostrar progreso en tiempo real
7. Al terminar, mostrar resumen con totales
```

---

## Beneficios

1. **Confiabilidad**: Archivos grandes ya no fallarán silenciosamente
2. **Visibilidad**: El usuario ve el progreso en tiempo real
3. **Compatibilidad**: Headers con caracteres especiales funcionarán correctamente
4. **Experiencia**: Mensajes de error claros y accionables
5. **Eficiencia**: Procesamiento en chunks evita timeouts y errores de memoria
