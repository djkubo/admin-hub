import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BusinessMetrics {
  todaySales: {
    totalUSD: number;
    totalMXN: number;
    transactionCount: number;
  };
  churnToday: {
    count: number;
    clients: Array<{ email: string; name: string }>;
  };
  topActiveUsers: Array<{
    email: string;
    name: string;
    eventCount: number;
    plan: string;
  }>;
  failedPayments: Array<{
    email: string;
    name: string;
    amount: number;
    failureDate: string;
  }>;
  emailBounces: Array<{
    email: string;
    name: string;
  }>;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('🧠 Starting business analysis...');

    // Get today's date boundaries
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();

    // 1. Get today's sales
    const { data: todayTransactions, error: transError } = await supabase
      .from('transactions')
      .select('amount, currency, status')
      .gte('created_at', startOfDay)
      .lt('created_at', endOfDay)
      .eq('status', 'succeeded');

    if (transError) {
      console.error('Error fetching transactions:', transError);
    }

    const todaySales = {
      totalUSD: 0,
      totalMXN: 0,
      transactionCount: todayTransactions?.length || 0,
    };

    todayTransactions?.forEach((t) => {
      if (t.currency?.toLowerCase() === 'mxn') {
        todaySales.totalMXN += t.amount;
      } else {
        todaySales.totalUSD += t.amount;
      }
    });

    console.log('💰 Today sales:', todaySales);

    // 2. Get churn today (clients with status 'Canceled' or 'Expired' updated today)
    const { data: churnedClients, error: churnError } = await supabase
      .from('clients')
      .select('email, full_name, status')
      .in('status', ['Canceled', 'Expired', 'Churned'])
      .gte('created_at', startOfDay)
      .lt('created_at', endOfDay);

    if (churnError) {
      console.error('Error fetching churned clients:', churnError);
    }

    const churnToday = {
      count: churnedClients?.length || 0,
      clients: churnedClients?.map(c => ({
        email: c.email || 'Unknown',
        name: c.full_name || 'Unknown',
      })) || [],
    };

    console.log('📉 Churn today:', churnToday.count);

    // 3. Get top 10 most active users (by event count in last 7 days)
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data: activeEvents, error: eventsError } = await supabase
      .from('client_events')
      .select('client_id')
      .gte('created_at', sevenDaysAgo)
      .in('event_type', ['email_open', 'email_click', 'login', 'high_usage']);

    if (eventsError) {
      console.error('Error fetching active events:', eventsError);
    }

    // Count events per client
    const eventCounts: Record<string, number> = {};
    activeEvents?.forEach(e => {
      eventCounts[e.client_id] = (eventCounts[e.client_id] || 0) + 1;
    });

    // Get top 10 client IDs
    const topClientIds = Object.entries(eventCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id]) => id);

    // Fetch client details for top users
    const { data: topClients, error: topError } = await supabase
      .from('clients')
      .select('id, email, full_name, status')
      .in('id', topClientIds.length > 0 ? topClientIds : ['00000000-0000-0000-0000-000000000000']);

    if (topError) {
      console.error('Error fetching top clients:', topError);
    }

    const topActiveUsers = topClientIds.map(id => {
      const client = topClients?.find(c => c.id === id);
      return {
        email: client?.email || 'Unknown',
        name: client?.full_name || 'Unknown',
        eventCount: eventCounts[id] || 0,
        plan: client?.status || 'Unknown',
      };
    });

    console.log('🌟 Top active users:', topActiveUsers.length);

    // 4. Get users with failed payments (last 7 days)
    const { data: failedPayments, error: failedError } = await supabase
      .from('transactions')
      .select('customer_email, amount, created_at')
      .eq('status', 'failed')
      .gte('created_at', sevenDaysAgo)
      .order('amount', { ascending: false })
      .limit(20);

    if (failedError) {
      console.error('Error fetching failed payments:', failedError);
    }

    // Get client names for failed payments
    const failedEmails = [...new Set(failedPayments?.map(f => f.customer_email).filter(Boolean))];
    const { data: failedClients } = await supabase
      .from('clients')
      .select('email, full_name')
      .in('email', failedEmails.length > 0 ? failedEmails : ['none@none.com']);

    const failedPaymentsList = failedPayments?.map(f => {
      const client = failedClients?.find(c => c.email === f.customer_email);
      return {
        email: f.customer_email || 'Unknown',
        name: client?.full_name || 'Unknown',
        amount: f.amount,
        failureDate: f.created_at,
      };
    }) || [];

    console.log('❌ Failed payments:', failedPaymentsList.length);

    // 5. Get email bounces (last 7 days)
    const { data: bounceEvents, error: bounceError } = await supabase
      .from('client_events')
      .select('client_id')
      .eq('event_type', 'email_bounce')
      .gte('created_at', sevenDaysAgo);

    if (bounceError) {
      console.error('Error fetching bounce events:', bounceError);
    }

    const bounceClientIds = [...new Set(bounceEvents?.map(e => e.client_id))];
    const { data: bouncedClients } = await supabase
      .from('clients')
      .select('email, full_name')
      .in('id', bounceClientIds.length > 0 ? bounceClientIds : ['00000000-0000-0000-0000-000000000000']);

    const emailBounces = bouncedClients?.map(c => ({
      email: c.email || 'Unknown',
      name: c.full_name || 'Unknown',
    })) || [];

    console.log('📧 Email bounces:', emailBounces.length);

    // Build metrics object
    const metrics: BusinessMetrics = {
      todaySales,
      churnToday,
      topActiveUsers,
      failedPayments: failedPaymentsList,
      emailBounces,
    };

    // Call Lovable AI for analysis
    console.log('🤖 Calling AI for strategic analysis...');

    const aiPrompt = `Eres un analista de negocios experto para un SaaS de DJs y productores musicales. Analiza estos datos del día de hoy y dame insights accionables.

DATOS DEL NEGOCIO:
${JSON.stringify(metrics, null, 2)}

TU TAREA:
1. **Resumen Ejecutivo** (2-3 oraciones sobre el estado del negocio hoy)

2. **3 Oportunidades de Upsell**: Identifica clientes activos que podrían beneficiarse de un plan superior. Para cada uno:
   - Nombre/Email del cliente
   - Por qué es candidato (alta actividad, plan básico, etc.)
   - Acción sugerida específica

3. **3 Riesgos de Fuga**: Identifica clientes en riesgo de cancelar. Para cada uno:
   - Nombre/Email del cliente  
   - Señales de alarma (pago fallido, rebote email, baja actividad)
   - Acción preventiva sugerida

4. **Acciones Prioritarias**: Lista 3 acciones concretas que el equipo debería tomar HOY.

Responde en formato JSON con esta estructura:
{
  "summary": "Resumen ejecutivo...",
  "opportunities": [
    {"client": "email", "reason": "razón", "action": "acción sugerida"}
  ],
  "risks": [
    {"client": "email", "signals": "señales", "prevention": "acción preventiva"}
  ],
  "priorityActions": ["acción 1", "acción 2", "acción 3"]
}`;

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        messages: [
          { 
            role: 'system', 
            content: 'Eres un consultor de negocios SaaS experto. Siempre respondes en JSON válido.' 
          },
          { role: 'user', content: aiPrompt }
        ],
        temperature: 0.7,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('AI API error:', aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ 
          error: 'Rate limit exceeded. Please try again later.' 
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ 
          error: 'AI credits exhausted. Please add credits to continue.' 
        }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      throw new Error(`AI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const aiContent = aiData.choices?.[0]?.message?.content || '';

    console.log('✅ AI response received');

    // Parse AI response
    let parsedInsights;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiContent.match(/```json\n?([\s\S]*?)\n?```/) || 
                        aiContent.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : aiContent;
      parsedInsights = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      parsedInsights = {
        summary: aiContent,
        opportunities: [],
        risks: [],
        priorityActions: [],
      };
    }

    // Save to ai_insights table
    const todayDate = today.toISOString().split('T')[0];
    
    const { data: insertedInsight, error: insertError } = await supabase
      .from('ai_insights')
      .upsert({
        date: todayDate,
        summary: parsedInsights.summary || 'No summary available',
        opportunities: parsedInsights.opportunities || [],
        risks: parsedInsights.risks || [],
        metrics: {
          ...metrics,
          priorityActions: parsedInsights.priorityActions || [],
        },
      }, {
        onConflict: 'date',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error saving insight:', insertError);
      throw insertError;
    }

    console.log('💾 Insight saved successfully:', insertedInsight.id);

    return new Response(JSON.stringify({
      success: true,
      insight: insertedInsight,
      metrics,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('❌ Error in analyze-business:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
