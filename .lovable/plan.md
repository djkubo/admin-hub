
# Plan: Conversión a Navegación con Rutas Reales

## Resumen

Convertir la navegación actual basada en estado (`activeMenuItem`) a rutas reales de React Router. Cada sección del dashboard tendrá su propia URL, mejorando el rendimiento y la experiencia de usuario.

## Beneficios

| Actual (Estado) | Nuevo (Rutas) |
|-----------------|---------------|
| Todo el código carga en `/` | Solo carga el código de la página activa |
| No hay historial de navegación | Botones "Atrás/Adelante" funcionan |
| No se puede compartir enlaces a secciones | URLs directas: `/clients`, `/invoices` |
| Todos los hooks se ejecutan siempre | Hooks aislados por ruta |

## Estructura de Rutas Nueva

```text
/                  → Dashboard (Command Center)
/movements         → Libro Mayor de Movimientos
/analytics         → Analytics Panel
/messages          → Hub de Mensajes
/campaigns         → Centro de Campañas
/broadcast         → Listas de Difusión
/flows             → Automatizaciones
/whatsapp          → WhatsApp Directo
/clients           → Clientes
/invoices          → Facturas
/subscriptions     → Suscripciones
/recovery          → Recovery Pipeline
/import            → Importar / Sync
/diagnostics       → Diagnostics
/settings          → Ajustes
```

## Implementación

### Fase 1: Crear Layout Compartido

Crear un componente `DashboardLayout.tsx` que envuelva todas las páginas del dashboard:

```text
┌────────────────────────────────────────────────────────────┐
│                    DashboardLayout                         │
│  ┌──────────┬───────────────────────────────────────────┐  │
│  │          │                                           │  │
│  │ Sidebar  │              <Outlet />                   │  │
│  │  (fijo)  │         (contenido dinámico)              │  │
│  │          │                                           │  │
│  └──────────┴───────────────────────────────────────────┘  │
│  └── SyncStatusBanner ──────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Fase 2: Modificar Sidebar para usar Links

Cambiar los `<button>` por `<NavLink>` de React Router:

- Usar `NavLink` con prop `className` que detecta ruta activa
- Remover props `activeItem` y `onItemClick`
- El estilo activo se aplica automáticamente

### Fase 3: Actualizar App.tsx con Rutas Anidadas

Usar rutas anidadas bajo el layout protegido:

```text
<Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
  <Route path="/" element={<DashboardHome />} />
  <Route path="/clients" element={<ClientsPage />} />
  <Route path="/invoices" element={<InvoicesPage />} />
  ... (14 rutas más)
</Route>
```

### Fase 4: Actualizar DashboardHome

Cambiar `onNavigate` por `useNavigate`:

- Reemplazar `onNavigate?.('clients')` por `navigate('/clients')`
- Los cards de KPIs navegarán a sus rutas correspondientes

---

## Archivos a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/App.tsx` | Agregar 14 rutas nuevas bajo layout protegido |
| `src/pages/Index.tsx` | Convertir a `DashboardLayout.tsx` con `<Outlet />` |
| `src/components/dashboard/Sidebar.tsx` | Cambiar buttons → NavLinks |
| `src/components/dashboard/DashboardHome.tsx` | Cambiar `onNavigate` → `useNavigate` |

## Archivos Nuevos

| Archivo | Propósito |
|---------|-----------|
| `src/layouts/DashboardLayout.tsx` | Layout compartido con Sidebar + Outlet |

---

## Detalles Técnicos

### DashboardLayout.tsx (nuevo)

```typescript
// Estructura del layout compartido
import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SyncStatusBanner } from "@/components/dashboard/SyncStatusBanner";

export function DashboardLayout() {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main className="md:pl-64 pt-14 md:pt-0">
        <div className="p-4 md:p-8 safe-area-bottom">
          <Outlet />
        </div>
      </main>
      <SyncStatusBanner />
    </div>
  );
}
```

### Sidebar.tsx - Cambios clave

```typescript
// Antes: buttons con onClick
<button onClick={() => onItemClick?.(item.id)}>

// Después: NavLinks con rutas
import { NavLink } from "react-router-dom";

// Mapeo de IDs a rutas
const routeMap = {
  dashboard: "/",
  clients: "/clients",
  invoices: "/invoices",
  // ... etc
};

<NavLink 
  to={routeMap[item.id]}
  className={({ isActive }) => cn(
    "flex w-full items-center gap-3 ...",
    isActive ? "bg-accent active-indicator" : "..."
  )}
>
```

### App.tsx - Rutas anidadas

```typescript
<Route element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
  <Route index element={<DashboardHome />} />
  <Route path="movements" element={<MovementsPage />} />
  <Route path="analytics" element={<AnalyticsPanel />} />
  <Route path="messages" element={<MessagesPageWrapper />} />
  <Route path="campaigns" element={<CampaignControlCenter />} />
  <Route path="broadcast" element={<BroadcastListsPage />} />
  <Route path="flows" element={<FlowsPage />} />
  <Route path="whatsapp" element={<WhatsAppSettingsPage />} />
  <Route path="clients" element={<ClientsPage />} />
  <Route path="invoices" element={<InvoicesPage />} />
  <Route path="subscriptions" element={<SubscriptionsPage />} />
  <Route path="recovery" element={<RevenueOpsPipeline />} />
  <Route path="import" element={<ImportSyncPage />} />
  <Route path="diagnostics" element={<DiagnosticsPanel />} />
  <Route path="settings" element={<SettingsPage />} />
</Route>
```

---

## Resultado Esperado

1. **Code Splitting automático** - Cada página carga solo cuando se visita
2. **Navegación nativa** - Botones Atrás/Adelante del navegador funcionan
3. **URLs compartibles** - `tusitio.com/clients` lleva directo a Clientes
4. **Mejor rendimiento** - Hooks no se ejecutan en páginas que no estás viendo
5. **SEO básico** - Cada sección tiene su propia URL

---

## Orden de Implementación

1. Crear `src/layouts/DashboardLayout.tsx`
2. Modificar `src/App.tsx` con rutas anidadas
3. Actualizar `src/components/dashboard/Sidebar.tsx` con NavLinks
4. Actualizar `src/components/dashboard/DashboardHome.tsx` con `useNavigate`
5. Eliminar código obsoleto de `src/pages/Index.tsx`
6. Probar todas las rutas y navegación
