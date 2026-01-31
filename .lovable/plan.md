
# Plan: Desplegar Edge Functions y Corregir Diagnostics

## Diagnóstico Confirmado

### Buenas Noticias:
- **No hay syncs atascados ejecutándose** - La base de datos confirma 0 syncs de GHL/ManyChat en estado "running"
- **Los webhooks de GHL funcionan bien** - Procesando correctamente y guardando en staging (~52 contactos)
- **El código `testOnly` YA EXISTE** en `sync-ghl` y `sync-manychat` (líneas 536-580 y 392-448 respectivamente)

### El Problema Real:
Las Edge Functions **tienen el código correcto pero NO están desplegadas** en Supabase. Cuando el IntegrationsStatusPanel envía `{ testOnly: true }`, la versión en producción NO reconoce ese parámetro y trata de ejecutar un sync completo → timeout → modal "atascado".

---

## Fase 1: Desplegar TODAS las Edge Functions Críticas

Desplegar inmediatamente:
1. `sync-ghl` - con modo testOnly  
2. `sync-manychat` - con modo testOnly
3. `reconcile-metrics` - con CORS corregido

Esto solucionará:
- Los modales de GoHighLevel y ManyChat "atascados"
- El error CORS de Reconciliación

---

## Fase 2: Verificar la Ruta de Error `rebuild_metrics_staging`

El log de consola muestra:
```
POST /rest/v1/rpc/rebuild_metrics_staging 404 (Not Found)
```

Esta función RPC puede no existir o tener un nombre diferente. Verificaré el schema y corregiré el DiagnosticsPanel si es necesario.

---

## Resumen de Cambios

| Acción | Descripción |
|--------|-------------|
| Desplegar `sync-ghl` | Activa modo `testOnly` para conexión instantánea |
| Desplegar `sync-manychat` | Activa modo `testOnly` para conexión instantánea |
| Desplegar `reconcile-metrics` | Activa CORS para producción |
| Revisar `rebuild_metrics_staging` | Verificar si existe y corregir el nombre si es necesario |

---

## Resultado Esperado

Después del despliegue:
- **Settings > Integraciones**: "Probar Conexión" responderá en < 2 segundos
- **Diagnostics > Reconciliación**: Funcionará sin error CORS
- **Diagnostics > Rebuild Metrics**: Si la función existe, funcionará; si no, se mostrará un mensaje de error claro
