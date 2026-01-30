
# Plan: Reparación de Secciones Importar/Sync y Ajustes

## Diagnóstico del Estado Actual

Tras revisar exhaustivamente el código, encontré lo siguiente:

### APISyncPanel.tsx (Importar/Sync)
- **Estado**: Ya está correctamente estilizado con la paleta VRP
- **Problema**: NO tiene colores arcoíris - ya usa `bg-zinc-800`, `border-zinc-800`, `text-white`, `bg-primary`
- **Acción**: Solo limpieza menor y optimización

### SettingsPage.tsx (Ajustes)
- **Estado**: Es un wrapper simple de 50 líneas
- **Problema Real**: Los sub-componentes tienen los colores incorrectos:
  - `IntegrationsStatusPanel.tsx` → Usa `text-purple-400`, `text-blue-400`, `text-green-400`, `text-cyan-400` para los íconos
  - `SystemTogglesPanel.tsx` → Usa `text-emerald-400`, `text-amber-400`, `text-blue-400`, `text-purple-400`, `text-cyan-400`

---

## Archivos a Modificar

| Archivo | Problema | Acción |
|---------|----------|--------|
| `IntegrationsStatusPanel.tsx` | Colores arcoíris en íconos | Neutralizar a `text-zinc-400` + sutil indicador de marca |
| `SystemTogglesPanel.tsx` | Colores semánticos en íconos | Neutralizar a `text-primary` |
| `GHLSettingsPanel.tsx` | Colores verde/amarillo en badges | Usar `.badge-success`/`.badge-warning` globales |
| `SettingsPage.tsx` | Sin skeleton de carga | Agregar Skeleton mientras cargan sub-componentes |

---

## Cambios Específicos

### 1. IntegrationsStatusPanel.tsx - Eliminar Colores de Marca

**Antes (Arcoíris):**
```tsx
const integrations = [
  { id: 'stripe', color: 'purple' },
  { id: 'paypal', color: 'blue' },
  { id: 'twilio', color: 'red' },
  { id: 'ghl', color: 'green' },
  { id: 'manychat', color: 'cyan' },
];

const getColorClasses = (color: string) => ({
  purple: 'text-purple-400',
  blue: 'text-blue-400',
  // etc...
});
```

**Después (Monocromático VRP):**
```tsx
// Eliminar la propiedad 'color' completamente
// Todos los íconos usan text-zinc-400 o text-primary
const integrations = [
  { id: 'stripe', name: 'Stripe', icon: CreditCard, ... },
  // Sin campo 'color'
];

// Ícono neutral para todos
<Icon className="h-5 w-5 text-zinc-400" />
```

### 2. SystemTogglesPanel.tsx - Neutralizar Íconos

**Antes:**
```tsx
<Bell className="h-5 w-5 text-emerald-400" />
<Pause className="h-5 w-5 text-amber-400" />
<Clock className="h-5 w-5 text-blue-400" />
<Building className="h-5 w-5 text-purple-400" />
<Clock className="h-5 w-5 text-cyan-400" />
```

**Después:**
```tsx
// Todos los íconos usan text-zinc-400 (neutral) o text-primary (acento)
<Bell className="h-5 w-5 text-zinc-400" />
<Pause className="h-5 w-5 text-zinc-400" />
<Clock className="h-5 w-5 text-zinc-400" />
<Building className="h-5 w-5 text-zinc-400" />
<Clock className="h-5 w-5 text-zinc-400" />
```

### 3. GHLSettingsPanel.tsx - Badges Estandarizados

**Antes:**
```tsx
<Badge className={isConfigured 
  ? "bg-green-500/10 text-green-400 border-green-500/30" 
  : "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
}>
```

**Después (usando clases globales):**
```tsx
<Badge variant={isConfigured ? "success" : "warning"}>
```

### 4. SettingsPage.tsx - Agregar Estado de Carga

**Mejora:**
```tsx
import { Skeleton } from '@/components/ui/skeleton';
import { Suspense, lazy } from 'react';

// Skeleton para loading states
const SettingsSkeleton = () => (
  <div className="space-y-4">
    <Skeleton className="h-48 w-full rounded-xl" />
    <Skeleton className="h-48 w-full rounded-xl" />
    <Skeleton className="h-48 w-full rounded-xl" />
  </div>
);

// Lazy loading de paneles pesados
const SystemTogglesPanel = lazy(() => import('./SystemTogglesPanel'));
const IntegrationsStatusPanel = lazy(() => import('./IntegrationsStatusPanel'));
const GHLSettingsPanel = lazy(() => import('./GHLSettingsPanel'));
```

---

## Resultado Visual Esperado

```text
┌─────────────────────────────────────────────────────────┐
│  ⚙️ AJUSTES                              [user@email]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  🔧 Configuración del Sistema                   │   │
│  │  ────────────────────────────────────────────   │   │
│  │  [🔔] Auto-Dunning          [====ON====]       │   │
│  │  [⏸] Pausar Sync            [===OFF===]        │   │
│  │  [⏰] Horario Silencioso     21:00 — 08:00     │   │
│  │  [🏢] Nombre Empresa         [_________]       │   │
│  │  [🌍] Zona Horaria           [CDMX ▼]          │   │
│  │                               [Guardar]         │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ⚡ Estado de Integraciones                     │   │
│  │  ────────────────────────────────────────────   │   │
│  │  [💳] Stripe        [Sin probar]    [🔄]       │   │
│  │  [💳] PayPal        [Conectado✓]    [🔄]       │   │
│  │  [💬] Twilio        [Sin probar]               │   │
│  │  [👥] GoHighLevel   [Error✗]        [🔄]       │   │
│  │  [🤖] ManyChat      [Sin probar]    [🔄]       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  ⚙️ GoHighLevel Integration   [Configurado ✓]  │   │
│  │  ────────────────────────────────────────────   │   │
│  │  Webhook URL:                                   │   │
│  │  [https://services.lead...          ] [💾]     │   │
│  │                                                 │   │
│  │  📋 ¿Cómo configurar?                          │   │
│  │  1. En GHL → Automation → Workflows...         │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘

PALETA:
- Fondo: #09090b (Zinc-950)
- Cards: #18181b (Zinc-900) con border #27272a
- Íconos: text-zinc-400 (neutro)
- Acento: #AA0601 (VRP Red) solo para botón Guardar
- Badges: Semantic (emerald=success, amber=warning, red=error)
```

---

## Sección Técnica

### Cambios en `IntegrationsStatusPanel.tsx`:
1. Eliminar el campo `color` del array de integraciones
2. Eliminar la función `getColorClasses()`
3. Cambiar todos los íconos a `text-zinc-400`
4. Mantener badges semánticos (success/error) solo para estados

### Cambios en `SystemTogglesPanel.tsx`:
1. Cambiar todos los íconos de colores a `text-zinc-400`
2. Usar `card-base` para el wrapper principal
3. Mantener el estado de loading con Skeleton

### Cambios en `GHLSettingsPanel.tsx`:
1. Usar `variant="success"` y `variant="warning"` del Badge
2. Cambiar `bg-green-500/10` → `badge-success`
3. Cambiar `bg-yellow-500/10` → `badge-warning`

### Cambios en `SettingsPage.tsx`:
1. Agregar `Suspense` con fallback `SettingsSkeleton`
2. Lazy-load de componentes pesados para mejor UX

---

## Beneficios

1. **Consistencia Visual**: Toda la sección Ajustes seguirá la paleta VRP monocromática
2. **Mejor UX**: Skeletons visibles durante carga en lugar de spinners solitarios
3. **Mantenibilidad**: Los badges usan variantes globales definidas en `badge.tsx`
4. **Profesionalismo**: Sin colores de marca (purple Stripe, blue PayPal) - todo neutral

