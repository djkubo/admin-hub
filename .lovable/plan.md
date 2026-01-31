
# Plan: Corregir CORS y Estados Fantasma de Sync

## Resumen del Problema
1. **Error CORS** en 4 Edge Functions que no tienen la URL de producción (`https://zen-admin-joy.lovable.app`) en sus origins permitidos
2. **Estados fantasma** en la UI de sync cuando las respuestas de API fallan silenciosamente

---

## Fase 1: Corregir CORS en Edge Functions

### Archivos a modificar:
1. `supabase/functions/reconcile-metrics/index.ts`
2. `supabase/functions/create-portal-session/index.ts`
3. `supabase/functions/force-charge-invoice/index.ts`
4. `supabase/functions/sync-clients/index.ts`

### Cambio en cada archivo:
Agregar la URL de producción a `ALLOWED_ORIGINS`:

```typescript
const ALLOWED_ORIGINS = [
  "https://id-preview--9d074359-befd-41d0-9307-39b75ab20410.lovable.app",
  "https://zen-admin-joy.lovable.app",  // <-- AGREGAR ESTA LÍNEA
  "https://lovable.dev",
  "http://localhost:5173",
  "http://localhost:3000",
];
```

---

## Fase 2: Prevenir Estados Fantasma en IntegrationsStatusPanel

### Archivo: `src/components/dashboard/IntegrationsStatusPanel.tsx`

### Mejoras:
1. **Timeout de seguridad** de 30 segundos para evitar spinners infinitos
2. **Limpieza automática** del estado `testing` en caso de error de red
3. **Mensaje de error más descriptivo** cuando hay problemas de conexión

```typescript
const testConnection = async (integration: Integration) => {
  if (!integration.testEndpoint) {
    toast.info('Esta integración no tiene prueba automática');
    return;
  }

  setTesting(integration.id);
  
  // Timeout de seguridad
  const timeout = setTimeout(() => {
    setTesting(null);
    setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
    toast.error(`${integration.name}: Timeout - sin respuesta`);
  }, 30000);
  
  try {
    const result = await invokeWithAdminKey<...>(...);
    clearTimeout(timeout);
    // ... resto de la lógica
  } catch (error) {
    clearTimeout(timeout);
    setTesting(null);
    setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
    toast.error(`Error probando ${integration.name}: ${error.message || 'Error de conexión'}`);
  }
};
```

---

## Fase 3: Verificar y Limpiar SyncCenter

### Archivo: `src/components/dashboard/SyncCenter.tsx`

### Mejora similar:
Agregar timeout de seguridad en las mutaciones de sync para evitar spinners infinitos.

---

## Resumen de Cambios

| Archivo | Cambio |
|---------|--------|
| `reconcile-metrics/index.ts` | Agregar URL de producción a CORS |
| `create-portal-session/index.ts` | Agregar URL de producción a CORS |
| `force-charge-invoice/index.ts` | Agregar URL de producción a CORS |
| `sync-clients/index.ts` | Agregar URL de producción a CORS |
| `IntegrationsStatusPanel.tsx` | Timeout de 30s para evitar spinners |
| `SyncCenter.tsx` | Timeout de 30s en mutaciones |

---

## Resultado Esperado
- Las funciones de Diagnostics (reconcile-metrics) funcionarán desde producción
- Los modales de test de conexiones nunca quedarán atascados
- Si algo falla, el usuario verá un mensaje claro en vez de un spinner infinito

