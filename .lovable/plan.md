# Funnelchat Clone - Plan de Implementación

## Estado Actual: FASE 3 COMPLETADA ✅

---

## ✅ Fase 1: Sistema Multiagente (COMPLETADO)

**Base de Datos:**
- ✅ Tabla `agents` - gestiona agentes con status online/away/offline
- ✅ Tabla `conversations` - agrupa chats con asignación a agentes
- ✅ Tabla `chat_assignments` - historial de asignaciones
- ✅ RLS policies para control de acceso
- ✅ Realtime enabled para actualizaciones en vivo

**Hooks (`src/hooks/useAgents.ts`):**
- ✅ `useAgents()` - lista todos los agentes
- ✅ `useOnlineAgents()` - agentes disponibles
- ✅ `useCurrentAgent()` - perfil del agente actual
- ✅ `useUpdateAgentStatus()` - cambiar status
- ✅ `useConversationsMultiagent()` - conversaciones con filtros
- ✅ `useAssignConversation()` - asignar chats a agentes
- ✅ `useUpdateConversationStatus()` - cambiar status de conversación

**Componentes UI:**
- ✅ `AgentStatusPanel.tsx` - panel de status de agentes con selector
- ✅ `ConversationAssignDialog.tsx` - modal para asignar conversaciones
- ✅ `ConversationFilters.tsx` - filtros Todos/Mis chats/Sin asignar
- ✅ Integración en `BotChatPage.tsx`

---

## ✅ Fase 2: Mensajes Multimedia (COMPLETADO)
- ✅ Bucket de storage `chat-media` con políticas RLS
- ✅ Columnas media_url, media_type, media_filename en chat_events
- ✅ `MediaAttachmentButton.tsx` - botones 📷 🎤 📎 📹
- ✅ `ChatMediaBubble.tsx` - renderizado de imágenes/audio/video
- ✅ Integración en BotChatPage con preview y envío

---

## ✅ Fase 3: Programación de Mensajes (COMPLETADO)
- ✅ Tabla `scheduled_messages` con índice para pending
- ✅ `ScheduleMessageDialog.tsx` - modal con date/time picker
- ✅ `ScheduledMessagesPanel.tsx` - vista de mensajes programados
- ✅ Hook `useScheduledMessages.ts` - CRUD de mensajes programados
- ✅ Botón de reloj ⏰ integrado en composer
- ✅ Opciones rápidas (1h, 3h, mañana 9AM/2PM)

---

## 🔄 Próximas Fases

### Fase 4: Constructor de Flujos Visual (2-4 semanas)
- [ ] Instalar React Flow
- [ ] Tabla `automation_flows` (nodes_json, edges_json)
- [ ] Tipos de nodos: Trigger, Message, Delay, Condition, Tag, Webhook
- [ ] Canvas drag-and-drop
- [ ] Motor de ejecución en edge function

### Fase 5: Grupos WhatsApp (1-2 semanas)
- [ ] Integración con WhatsApp Business API grupos
- [ ] UI de gestión de grupos y miembros

---

## Arquitectura Actual

```
Frontend (React + Vite)
├── BotChatPage.tsx (Chat con multimedia + programación)
├── MediaAttachmentButton.tsx (Adjuntos)
├── ScheduleMessageDialog.tsx (Programación)
├── AgentStatusPanel.tsx (Panel de agentes)
├── ConversationAssignDialog.tsx (Asignación)
└── ConversationFilters.tsx (Filtros)

Hooks
├── useAgents.ts (Lógica de agentes)
├── useScheduledMessages.ts (Mensajes programados)
├── useChatEvents.ts (Mensajes del bot)
└── useMessages.ts (Mensajes generales)

Base de Datos (Supabase)
├── agents (Agentes del equipo)
├── conversations (Conversaciones agrupadas)
├── chat_assignments (Historial)
├── scheduled_messages (Mensajes programados)
├── chat_events (Mensajes del bot + media)
└── messages (Mensajes SMS/WA)

Storage
└── chat-media (Bucket para multimedia)
```

---

## Comparativa: Funnelchat vs VRP

| Feature | VRP Status | Funnelchat |
|---------|------------|------------|
| Inbox de mensajes | ✅ | ✅ |
| Chat bot IA | ✅ | ✅ |
| Segmentación | ✅ | ✅ |
| Plantillas | ✅ | ✅ |
| Campañas | ✅ | ✅ |
| Tags/Etiquetas | ✅ | ✅ |
| Variables dinámicas | ✅ | ✅ |
| Quiet hours | ✅ | ✅ |
| Realtime | ✅ | ✅ |
| Análisis sentimiento | ✅ | ✅ |
| **Sistema multiagente** | ✅ | ✅ |
| **Multimedia** | ✅ | ✅ |
| **Programación mensajes** | ✅ | ✅ |
| Flujos visuales | ⏳ Fase 4 | ✅ |
| Grupos WA | ⏳ Fase 5 | ✅ |

**Progreso: ~95% de paridad con Funnelchat**
