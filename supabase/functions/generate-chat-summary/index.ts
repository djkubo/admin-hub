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
  meta: { name?: string; email?: string } | null;
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

    console.log(`📊 Generating chat summary for range: ${timeRange}`);

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
    let query = supabase
      .from("chat_events")
      .select("*")
      .order("created_at", { ascending: true });

    if (dateFilter) {
      query = query.gte("created_at", dateFilter);
    }

    const { data: events, error } = await query.limit(2000);

    if (error) {
      console.error("Error fetching chat_events:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch chat data" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!events || events.length === 0) {
      return new Response(
        JSON.stringify({ 
          summary: "## 📭 Sin datos\n\nNo hay conversaciones en el período seleccionado.",
          stats: { totalMessages: 0, totalContacts: 0 }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`📬 Found ${events.length} chat events`);

    // Group messages by contact_id for context
    const contactConversations: Record<string, { 
      name: string | null; 
      email: string | null;
      messages: string[];
    }> = {};

    for (const event of events as ChatEvent[]) {
      if (!event.message) continue;
      
      if (!contactConversations[event.contact_id]) {
        contactConversations[event.contact_id] = {
          name: event.meta?.name || null,
          email: event.meta?.email || null,
          messages: []
        };
      }
      
      const prefix = event.sender === "user" ? "👤 Usuario" : "🤖 Bot";
      contactConversations[event.contact_id].messages.push(`${prefix}: ${event.message}`);
    }

    // Build context for AI
    const conversationSummaries: string[] = [];
    let totalUserMessages = 0;

    for (const [contactId, conv] of Object.entries(contactConversations)) {
      const contactName = conv.name || conv.email || contactId.substring(0, 8);
      const userMessages = conv.messages.filter(m => m.startsWith("👤")).length;
      totalUserMessages += userMessages;
      
      if (conv.messages.length > 0) {
        conversationSummaries.push(
          `--- Contacto: ${contactName} ---\n${conv.messages.slice(-10).join("\n")}`
        );
      }
    }

    // Limit context to avoid token overflow
    const contextText = conversationSummaries.slice(0, 50).join("\n\n");
    const totalContacts = Object.keys(contactConversations).length;

    console.log(`📝 Preparing AI analysis for ${totalContacts} contacts, ${totalUserMessages} user messages`);

    // Call Lovable AI for analysis
    const systemPrompt = `Eres un analista de negocios experto en CRM y atención al cliente. 
Analiza las siguientes conversaciones de chat y genera un reporte ejecutivo en español.

FORMATO DE RESPUESTA (usa Markdown):

## 📊 Resumen Ejecutivo
Describe brevemente de qué habló la mayoría de usuarios. Ejemplo: "El 80% preguntó por disponibilidad de USB-C".

## 😊 Análisis de Sentimiento
- Positivo: X%
- Neutral: X%
- Negativo: X%
Incluye una breve explicación del tono general.

## 💰 Top Leads (Alta Intención de Compra)
Lista los nombres/contactos que mostraron intención clara de compra con detalles:
1. **[Nombre]** - [Producto/servicio mencionado] - [Señal de compra]

## ⚠️ Problemas Detectados
Lista cualquier queja, error técnico o problema reportado:
- [Problema] - Frecuencia: [alta/media/baja]

## 💡 Recomendaciones
2-3 acciones concretas para mejorar ventas o servicio.

---
Estadísticas: ${totalContacts} contactos, ${totalUserMessages} mensajes de usuarios, ${events.length} mensajes totales.`;

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
          { role: "user", content: `Analiza estas conversaciones:\n\n${contextText}` }
        ],
        max_tokens: 2000,
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

    console.log("✅ AI summary generated successfully");

    return new Response(
      JSON.stringify({
        summary,
        stats: {
          totalMessages: events.length,
          totalContacts,
          totalUserMessages,
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
