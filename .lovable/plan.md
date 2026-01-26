
# Plan: Solución Integral para Sincronización de Stripe

## Objetivo
Resolver los problemas recurrentes de error 409 y mejorar la visibilidad del progreso de sincronización.

## Diagnóstico Confirmado
- **Error 409**: Ocurre porque el frontend no maneja bien los syncs en segundo plano
- **1424 registros**: Es correcto - representa las transacciones nuevas/actualizadas (no duplicados)
- **Data actual**: 118,733 transacciones de Stripe ya sincronizadas (Feb 2019 - Hoy)

## Cambios Propuestos

### 1. Limpieza Automática de Syncs Atascados (Backend)

**Archivo**: `supabase/functions/fetch-stripe/index.ts`

Modificar para que antes de verificar syncs existentes, cancele automáticamente cualquier sync de más de 15 minutos:

```text
-- Reducir umbral de 30 minutos a 15 minutos
-- Esto evita que syncs abandonados bloqueen nuevas ejecuciones
```

### 2. Botón "Forzar Cancelar" en Frontend

**Archivo**: `src/components/dashboard/DashboardHome.tsx`

Agregar un botón visible cuando se detecte un 409 que permita:
- Cancelar el sync bloqueado manualmente
- Reiniciar la sincronización sin intervención técnica

### 3. Mejorar Manejo del 409 en Frontend

**Archivo**: `src/components/dashboard/DashboardHome.tsx`

En lugar de mostrar error, ofrecer opciones:
- "Continuar sync existente" (usar resumeSyncId)
- "Cancelar y reiniciar" 
- "Ver progreso" (navegar al panel de resultados)

### 4. Panel de Estado de Sync Mejorado

**Archivo**: `src/components/dashboard/SyncResultsPanel.tsx`

Mostrar claramente:
- Syncs activos vs completados
- Tiempo transcurrido
- Opción de cancelar syncs atascados

## Detalle Técnico

### Cambio 1: Auto-limpieza agresiva
```typescript
// En fetch-stripe/index.ts, línea ~579-585
// Cambiar el umbral de 30 minutos a 15 minutos
const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
```

### Cambio 2: Agregar endpoint de cancelación
```typescript
// Nuevo parámetro en fetch-stripe
if (body.forceCancel) {
  // Cancelar TODOS los syncs running de stripe
  await supabase
    .from('sync_runs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('source', 'stripe')
    .in('status', ['running', 'continuing']);
  
  return { success: true, cancelled: true };
}
```

### Cambio 3: UI mejorada para 409
```typescript
// En DashboardHome.tsx, en el catch del 409
if (errorMessage.includes('sync_already_running')) {
  toast.warning('Sincronización activa', {
    description: 'Hay un sync en progreso.',
    action: {
      label: 'Cancelar y reiniciar',
      onClick: () => handleForceCancel()
    }
  });
}
```

### Cambio 4: Función para cancelar forzado
```typescript
const handleForceCancel = async () => {
  await invokeWithAdminKey('fetch-stripe', { forceCancel: true });
  toast.success('Syncs cancelados');
  // Reiniciar automáticamente
  handleSyncAll(selectedRange);
};
```

## Archivos a Modificar

1. `supabase/functions/fetch-stripe/index.ts` - Auto-limpieza + endpoint forceCancel
2. `src/components/dashboard/DashboardHome.tsx` - Manejo mejorado del 409 + botón cancelar
3. `src/components/dashboard/SyncResultsPanel.tsx` - Botón cancelar visible para syncs activos

## Beneficios

1. **No más intervención manual** - El sistema se auto-limpia
2. **Control del usuario** - Puede cancelar syncs bloqueados desde la UI
3. **Mejor visibilidad** - Sabe exactamente qué está pasando
4. **Menos frustración** - El error 409 se convierte en una acción útil

## Validación Post-Implementación

Para verificar que toda la data está sincronizada:
```sql
SELECT COUNT(*), MIN(stripe_created_at), MAX(stripe_created_at) 
FROM transactions WHERE source = 'stripe';
```

Actualmente: 118,733 transacciones (Feb 2019 - Hoy) ✅

