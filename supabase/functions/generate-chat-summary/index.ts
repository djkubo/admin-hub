import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ChatEvent {
  id: number;
  contact_id: string;
  platform: string;
  sender: string;
  message: string | null;
  created_at: string;
  meta: { name?: string; email?: string; phone?: string } | null;
}

interface Client {
  id: string;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  full_name: string | null;
  total_spend: number | null;
  lifecycle_stage: string | null;
  status: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      console.error("LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body = await req.json();
    const { timeRange } = body; // '24h' | '7d' | '30d' | 'all'

    console.log(`📊 Generating SALES INTELLIGENCE report for range: ${timeRange}`);

    // Calculate date filter
    let dateFilter: string | null = null;
    const now = new Date();
    
    switch (timeRange) {
      case "24h":
        dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        break;
      case "7d":
        dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case "30d":
        dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case "all":
      default:
        dateFilter = null;
    }

    // Fetch chat events
    let eventsQuery = supabase
      .from("chat_events")
      .select("*")
      .order("created_at", { ascending: true });

    if (dateFilter) {
      eventsQuery = eventsQuery.gte("created_at", dateFilter);
    }

    const { data: events, error: eventsError } = await eventsQuery.limit(3000);

    if (eventsError) {
      console.error("Error fetching chat_events:", eventsError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch chat data" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!events || events.length === 0) {
      return new Response(
        JSON.stringify({ 
          summary: "## 📭 Sin datos\n\nNo hay conversaciones en el período seleccionado.",
          stats: { totalMessages: 0, totalContacts: 0, leads: 0, customers: 0 }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📬 Found ${events.length} chat events`);

    // Fetch ALL clients to cross-reference spending data
    const { data: clients, error: clientsError } = await supabase
      .from("clients")
      .select("id, email, phone, phone_e164, full_name, total_spend, lifecycle_stage, status")
      .limit(10000);

    if (clientsError) {
      console.error("Error fetching clients:", clientsError);
    }

    console.log(`👥 Found ${clients?.length || 0} clients for cross-reference`);

    // Build lookup maps for clients by email and phone
    const clientByEmail: Record<string, Client> = {};
    const clientByPhone: Record<string, Client> = {};

    for (const client of (clients || []) as Client[]) {
      if (client.email) {
        clientByEmail[client.email.toLowerCase().trim()] = client;
      }
      if (client.phone_e164) {
        clientByPhone[client.phone_e164] = client;
      }
      if (client.phone) {
        // Normalize phone for matching
        const normalizedPhone = client.phone.replace(/\D/g, "");
        if (normalizedPhone.length >= 10) {
          clientByPhone[normalizedPhone] = client;
        }
      }
    }

    // Group messages by contact_id and enrich with client data
    interface ConversationData {
      contactId: string;
      name: string | null;
      email: string | null;
      phone: string | null;
      messages: { sender: string; text: string; timestamp: string }[];
      client: Client | null;
      totalSpend: number;
      isLead: boolean;
      isCustomer: boolean;
      lastUserMessage: string | null;
      lastBotMessage: string | null;
      userStoppedResponding: boolean;
    }

    const conversations: Record<string, ConversationData> = {};

    for (const event of events as ChatEvent[]) {
      const contactId = event.contact_id;
      
      if (!conversations[contactId]) {
        // Try to find matching client
        let matchedClient: Client | null = null;
        
        const eventEmail = event.meta?.email?.toLowerCase().trim();
        const eventPhone = event.meta?.phone?.replace(/\D/g, "");
        
        if (eventEmail && clientByEmail[eventEmail]) {
          matchedClient = clientByEmail[eventEmail];
        } else if (eventPhone && clientByPhone[eventPhone]) {
          matchedClient = clientByPhone[eventPhone];
        }

        const totalSpend = matchedClient?.total_spend || 0;
        
        conversations[contactId] = {
          contactId,
          name: event.meta?.name || matchedClient?.full_name || null,
          email: eventEmail || matchedClient?.email || null,
          phone: event.meta?.phone || matchedClient?.phone || null,
          messages: [],
          client: matchedClient,
          totalSpend,
          isLead: totalSpend === 0,
          isCustomer: totalSpend > 0,
          lastUserMessage: null,
          lastBotMessage: null,
          userStoppedResponding: false
        };
      }

      if (event.message) {
        conversations[contactId].messages.push({
          sender: event.sender,
          text: event.message,
          timestamp: event.created_at
        });

        if (event.sender === "user") {
          conversations[contactId].lastUserMessage = event.message;
        } else {
          conversations[contactId].lastBotMessage = event.message;
        }
      }
    }

    // Analyze conversation patterns
    const allConvos = Object.values(conversations);
    
    // Detect "stopped responding" - last message was from bot
    for (const conv of allConvos) {
      if (conv.messages.length > 0) {
        const lastMsg = conv.messages[conv.messages.length - 1];
        conv.userStoppedResponding = lastMsg.sender === "bot";
      }
    }

    // Segment conversations
    const leadConvos = allConvos.filter(c => c.isLead && c.messages.length > 2);
    const customerConvos = allConvos.filter(c => c.isCustomer && c.messages.length > 2);
    const abandonedLeads = leadConvos.filter(c => c.userStoppedResponding);

    console.log(`📈 Segmentation: ${leadConvos.length} leads, ${customerConvos.length} customers, ${abandonedLeads.length} abandoned`);

    // Build context for AI - SALES INTELLIGENCE focused
    const buildConversationText = (conv: ConversationData, limit = 15) => {
      const msgs = conv.messages.slice(-limit);
      const header = `[${conv.name || conv.email || conv.contactId.substring(0, 8)}] (Gasto: $${conv.totalSpend})`;
      const body = msgs.map(m => `${m.sender === "user" ? "👤" : "🤖"}: ${m.text}`).join("\n");
      return `${header}\n${body}`;
    };

    // Prepare segmented data for AI
    const abandonedLeadsText = abandonedLeads
      .slice(0, 25)
      .map(c => buildConversationText(c))
      .join("\n\n---\n\n");

    const customerConvosText = customerConvos
      .slice(0, 25)
      .map(c => buildConversationText(c))
      .join("\n\n---\n\n");

    const allConvosText = allConvos
      .slice(0, 30)
      .map(c => buildConversationText(c, 10))
      .join("\n\n---\n\n");

    // Stats
    const totalContacts = allConvos.length;
    const totalUserMessages = events.filter((e: ChatEvent) => e.sender === "user").length;
    const totalRevenue = customerConvos.reduce((sum, c) => sum + c.totalSpend, 0);

    console.log(`💰 Total revenue from chatters: $${totalRevenue}`);

    // SALES INTELLIGENCE PROMPT
    const systemPrompt = `Eres un analista de ventas experto especializado en conversión de leads y optimización de chatbots de venta.

Tu misión es analizar conversaciones de chat y generar INTELIGENCIA DE VENTAS ACCIONABLE.

CONTEXTO DE NEGOCIO:
- Total de contactos en período: ${totalContacts}
- Leads (gasto = $0): ${leadConvos.length}
- Clientes (gasto > $0): ${customerConvos.length}  
- Leads que abandonaron chat: ${abandonedLeads.length}
- Revenue total de usuarios del chat: $${totalRevenue.toLocaleString()}

GENERA EL SIGUIENTE REPORTE EN ESPAÑOL:

---

## 📊 Resumen Ejecutivo
Breve resumen de 2-3 líneas sobre el estado de las conversaciones.

## 😊 Análisis de Sentimiento General
- Positivo: X%
- Neutral: X%  
- Negativo: X%

---

## 🛑 TOP 3 OBJECIONES DE VENTA (¿Por qué pierdo dinero?)

Analiza los chats de LEADS (Gasto = $0) que dejaron de contestar.
Identifica patrones y excusas comunes.

**Objeción #1: [NOMBRE]** (X% de los casos)
- Ejemplo real: "[cita del chat]"
- Impacto estimado: [alto/medio/bajo]

**Objeción #2: [NOMBRE]** (X% de los casos)
- Ejemplo real: "[cita del chat]"

**Objeción #3: [NOMBRE]** (X% de los casos)
- Ejemplo real: "[cita del chat]"

---

## 🏆 PATRONES DE ÉXITO (¿Cómo gano dinero?)

Analiza los chats de CLIENTES (Gasto > $0).
¿Qué argumento o tema apareció JUSTO ANTES de la compra?

**Patrón Ganador #1:** [descripción]
- 💬 Frase Ganadora sugerida: "[frase para entrenar al bot]"

**Patrón Ganador #2:** [descripción]
- 💬 Frase Ganadora sugerida: "[frase]"

---

## 💡 OPORTUNIDADES OCULTAS (Dinero en la mesa)

Busca menciones de productos/géneros que el bot NO supo responder o que NO tenemos.

1. **[Producto/Género pedido]** - Mencionado por X usuarios
   - Ejemplo: "[cita donde lo piden]"
   - Acción sugerida: [crear producto / agregar respuesta]

2. **[Producto/Género]** - X menciones
   - Ejemplo: "[cita]"

---

## 💰 Leads Prioritarios para Seguimiento

Lista de 3-5 leads con nombre/contacto que mostraron alta intención pero no compraron:

1. **[Nombre]** - Interesado en: [producto] - Última actividad: [fecha aprox]
2. ...

---

IMPORTANTE:
- Sé específico con ejemplos reales de los chats
- Los porcentajes pueden ser estimaciones basadas en lo que ves
- Si no hay suficientes datos para una sección, indícalo
- Usa íconos para hacer el reporte visualmente escaneable`;

    const userPrompt = `DATOS PARA ANALIZAR:

=== LEADS QUE ABANDONARON (Gasto = $0, dejaron de responder) ===
${abandonedLeadsText || "No hay datos suficientes de leads abandonados."}

=== CONVERSACIONES DE CLIENTES (Gasto > $0) ===
${customerConvosText || "No hay datos suficientes de clientes."}

=== MUESTRA GENERAL DE TODAS LAS CONVERSACIONES ===
${allConvosText}

Genera el reporte de INTELIGENCIA DE VENTAS siguiendo el formato especificado.`;

    console.log(`🤖 Calling AI for sales intelligence analysis...`);

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 3000,
        temperature: 0.7
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Límite de tasa excedido. Intenta en unos minutos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      return new Response(
        JSON.stringify({ error: "Error al generar análisis" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const summary = aiData.choices?.[0]?.message?.content || "No se pudo generar el resumen.";

    console.log("✅ Sales intelligence report generated successfully");

    return new Response(
      JSON.stringify({
        summary,
        stats: {
          totalMessages: events.length,
          totalContacts,
          totalUserMessages,
          leads: leadConvos.length,
          customers: customerConvos.length,
          abandonedLeads: abandonedLeads.length,
          totalRevenue,
          timeRange
        }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Error in generate-chat-summary:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
