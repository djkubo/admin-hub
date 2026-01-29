

# Fase 4: Constructor de Flujos Visual (Automation Flow Builder)

## Objetivo
Crear un editor visual drag-and-drop similar a Funnelchat para diseñar automatizaciones de mensajería. Los usuarios podrán crear flujos que se ejecuten automáticamente cuando ocurran eventos específicos (nuevo lead, pago fallido, trial expirando, etc.).

---

## Arquitectura del Sistema

```text
+----------------------+     +--------------------+     +-------------------+
|                      |     |                    |     |                   |
|   Flow Builder UI    |---->|   Supabase DB      |---->|  Execution Engine |
|   (React Flow)       |     |   automation_flows |     |  (Edge Function)  |
|                      |     |                    |     |                   |
+----------+-----------+     +---------+----------+     +---------+---------+
           |                           |                          |
           v                           v                          v
+----------------------+     +--------------------+     +-------------------+
|  Node Types:         |     |  Tables:           |     |  Actions:         |
|  - Trigger           |     |  - automation_flows|     |  - Send Message   |
|  - Send Message      |     |  - flow_executions |     |  - Add Tag        |
|  - Wait/Delay        |     |                    |     |  - Webhook Call   |
|  - Condition (If/Else)|    |                    |     |  - Update Client  |
|  - Add Tag           |     |                    |     |                   |
|  - Webhook           |     |                    |     |                   |
+----------------------+     +--------------------+     +-------------------+
```

---

## Implementacion por Etapas

### Etapa 1: Base de Datos

**Nueva tabla `automation_flows`:**
```sql
CREATE TABLE automation_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,  -- 'new_lead', 'payment_failed', 'trial_expiring', 'tag_added', 'manual'
  trigger_config JSONB DEFAULT '{}',
  nodes_json JSONB NOT NULL DEFAULT '[]',
  edges_json JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT false,
  is_draft BOOLEAN DEFAULT true,
  total_executions INT DEFAULT 0,
  successful_executions INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**Nueva tabla `flow_executions` (historial):**
```sql
CREATE TABLE flow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID REFERENCES automation_flows(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id),
  trigger_event TEXT NOT NULL,
  current_node_id TEXT,
  status TEXT DEFAULT 'running',  -- running, completed, failed, paused
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  execution_log JSONB DEFAULT '[]',
  error_message TEXT
);
```

### Etapa 2: Componentes React Flow

**Archivo `src/components/flows/FlowBuilder.tsx`:**
- Canvas principal con React Flow
- Zoom, pan, minimap, controles
- Guardado automatico del estado

**Archivo `src/components/flows/NodesSidebar.tsx`:**
- Panel lateral con nodos arrastrables
- Categorias: Triggers, Actions, Logic
- Iconos descriptivos para cada tipo

**Archivo `src/components/flows/nodes/` (Custom Nodes):**

| Nodo | Archivo | Funcion |
|------|---------|---------|
| TriggerNode | `TriggerNode.tsx` | Evento que inicia el flujo |
| MessageNode | `MessageNode.tsx` | Envia mensaje WA/SMS/Email |
| DelayNode | `DelayNode.tsx` | Espera X minutos/horas/dias |
| ConditionNode | `ConditionNode.tsx` | If/Else con 2 salidas |
| TagNode | `TagNode.tsx` | Agrega/quita tag al cliente |
| WebhookNode | `WebhookNode.tsx` | Llama a URL externa |
| EndNode | `EndNode.tsx` | Finaliza el flujo |

**Archivo `src/components/flows/NodeEditor.tsx`:**
- Panel lateral derecho (drawer)
- Formulario dinamico segun tipo de nodo
- Editor de plantillas con variables

### Etapa 3: Logica y Hooks

**Archivo `src/hooks/useAutomationFlows.ts`:**
```typescript
// Queries
useAutomationFlows()          // Lista todos los flujos
useAutomationFlow(id)         // Detalle de un flujo
useFlowExecutions(flowId)     // Historial de ejecuciones

// Mutations
useCreateFlow()               // Crear nuevo flujo
useUpdateFlow()               // Guardar cambios
useToggleFlowActive()         // Activar/desactivar
useDeleteFlow()               // Eliminar flujo
```

### Etapa 4: Pagina Principal

**Archivo `src/components/dashboard/FlowsPage.tsx`:**
- Lista de flujos con status (activo/draft)
- Estadisticas (ejecuciones, exitos, fallos)
- Botones: Crear, Editar, Duplicar, Eliminar
- Preview del flujo en miniatura

**Actualizacion del Sidebar:**
- Agregar item "Automatizaciones" con icono `Workflow`
- Posicion: despues de Campañas

### Etapa 5: Motor de Ejecucion

**Edge Function `execute-flow/index.ts`:**
```typescript
// Entrada: { flow_id, client_id, trigger_event }
// Proceso:
// 1. Cargar flow desde DB
// 2. Crear registro en flow_executions
// 3. Ejecutar nodos secuencialmente:
//    - Message -> llamar send-sms/notify-ghl
//    - Delay -> programar continuacion
//    - Condition -> evaluar y seguir rama
//    - Tag -> actualizar cliente
//    - Webhook -> fetch externo
// 4. Marcar como completado/fallido
```

---

## Tipos de Nodos Detallados

### 1. Trigger Node (Inicio)
```typescript
interface TriggerNodeData {
  type: 'new_lead' | 'payment_failed' | 'trial_expiring' | 'tag_added' | 'manual';
  config: {
    tagName?: string;           // Para tag_added
    daysBeforeExpiry?: number;  // Para trial_expiring
  };
}
```

### 2. Message Node
```typescript
interface MessageNodeData {
  channel: 'whatsapp' | 'sms' | 'email';
  templateId?: string;
  customMessage?: string;
  variables: string[];  // {{name}}, {{amount}}, etc.
}
```

### 3. Delay Node
```typescript
interface DelayNodeData {
  duration: number;
  unit: 'minutes' | 'hours' | 'days';
}
```

### 4. Condition Node
```typescript
interface ConditionNodeData {
  field: 'lifecycle_stage' | 'total_spend' | 'has_tag' | 'last_payment_status';
  operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
  value: string | number;
  // Salidas: "true" y "false"
}
```

### 5. Tag Node
```typescript
interface TagNodeData {
  action: 'add' | 'remove';
  tagName: string;
}
```

### 6. Webhook Node
```typescript
interface WebhookNodeData {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}
```

---

## Archivos a Crear

```text
src/
├── components/
│   └── flows/
│       ├── FlowBuilder.tsx          # Canvas principal
│       ├── FlowsList.tsx            # Lista de flujos
│       ├── NodesSidebar.tsx         # Panel de nodos
│       ├── NodeEditor.tsx           # Editor de propiedades
│       └── nodes/
│           ├── TriggerNode.tsx
│           ├── MessageNode.tsx
│           ├── DelayNode.tsx
│           ├── ConditionNode.tsx
│           ├── TagNode.tsx
│           ├── WebhookNode.tsx
│           └── EndNode.tsx
├── hooks/
│   └── useAutomationFlows.ts
└── dashboard/
    └── FlowsPage.tsx                # Pagina contenedora

supabase/
├── migrations/
│   └── XXXXXX_automation_flows.sql
└── functions/
    └── execute-flow/
        └── index.ts
```

---

## Dependencia Nueva

```json
{
  "@xyflow/react": "^12.0.0"
}
```

---

## UI/UX del Flow Builder

El canvas seguira el estilo Premium SaaS ya implementado:

- **Fondo:** Grid sutil sobre zinc-950
- **Nodos:** Cards con bg-zinc-900, borde zinc-800, sombra soft
- **Handles (conectores):** Circulos rojos (VRP accent)
- **Edges (lineas):** Lineas zinc-500 con animacion al seleccionar
- **Sidebar izquierdo:** Nodos arrastrables organizados por categoria
- **Sidebar derecho:** Editor de propiedades del nodo seleccionado
- **Header:** Nombre del flujo + botones Save/Activate/Preview

---

## Orden de Implementacion

1. Instalar dependencia `@xyflow/react`
2. Crear migracion de base de datos
3. Crear nodos personalizados (TriggerNode, MessageNode, etc.)
4. Crear FlowBuilder con canvas basico
5. Crear NodesSidebar con drag-and-drop
6. Crear NodeEditor para configurar propiedades
7. Crear hook useAutomationFlows
8. Crear FlowsPage y agregar al Sidebar
9. Crear edge function execute-flow
10. Actualizar plan.md

---

## Resultado Esperado

Un constructor visual de automatizaciones al estilo Funnelchat donde los usuarios pueden:
- Arrastrar nodos al canvas
- Conectarlos con lineas
- Configurar cada nodo (mensaje, delay, condicion)
- Guardar y activar el flujo
- Ver estadisticas de ejecucion

Esto completaria la funcionalidad estrella que diferencia a Funnelchat y llevaria la plataforma VRP a **100% de paridad funcional**.

