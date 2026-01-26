import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ActionableSegment {
  segment: string;
  description: string;
  count: number;
  priority: 'high' | 'medium' | 'low';
  action: string;
  clients: Array<{
    email: string;
    name: string;
    amount?: number;
    date?: string;
    reason?: string;
  }>;
}

interface DailyMetrics {
  date: string;
  summary: {
    totalSalesUSD: number;
    totalSalesMXN: number;
    transactionCount: number;
    newSubscriptions: number;
    newTrials: number;
    conversions: number;
    cancellations: number;
    failedPayments: number;
    churnRisk: number;
  };
  segments: ActionableSegment[];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getUser(token);
    
    if (claimsError || !claimsData?.user) {
      console.error("Auth error:", claimsError);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", claimsData.user.email);

    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('🧠 Starting comprehensive daily analysis...');

    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
    const last7Days = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const segments: ActionableSegment[] = [];

    // 1. FAILED PAYMENTS (LAST 7 DAYS)
    const { data: failedTx } = await supabase
      .from('transactions')
      .select('customer_email, amount, currency, stripe_created_at, failure_message')
      .eq('status', 'failed')
      .gte('stripe_created_at', last7Days)
      .order('stripe_created_at', { ascending: false });

    const failedEmails = [...new Set(failedTx?.map(t => t.customer_email).filter(Boolean))];
    const { data: failedClients } = await supabase
      .from('clients')
      .select('email, full_name')
      .in('email', failedEmails.length > 0 ? failedEmails : ['none']);

    const failedPaymentsSegment: ActionableSegment = {
      segment: 'pagos_fallidos',
      description: 'Clientes con pagos fallidos en los últimos 7 días',
      count: failedEmails.length,
      priority: 'high',
      action: 'Contactar inmediatamente para actualizar método de pago',
      clients: failedTx?.map(t => {
        const client = failedClients?.find(c => c.email === t.customer_email);
        return {
          email: t.customer_email || 'Desconocido',
          name: client?.full_name || 'Sin nombre',
          amount: t.amount / 100,
          date: t.stripe_created_at?.split('T')[0] || '',
          reason: t.failure_message || 'Error de pago',
        };
      }).filter((v, i, a) => a.findIndex(t => t.email === v.email) === i) || [],
    };
    segments.push(failedPaymentsSegment);
    console.log('❌ Failed payments:', failedPaymentsSegment.count);

    // 2. CANCELLATIONS
    const { data: cancelledClients } = await supabase
      .from('clients')
      .select('email, full_name, status, created_at')
      .in('lifecycle_stage', ['CHURN'])
      .gte('created_at', last7Days);

    const cancellationsSegment: ActionableSegment = {
      segment: 'cancelaciones',
      description: 'Clientes que cancelaron en los últimos 7 días',
      count: cancelledClients?.length || 0,
      priority: 'high',
      action: 'Enviar encuesta de salida y oferta de recuperación',
      clients: cancelledClients?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        date: c.created_at?.split('T')[0] || '',
        reason: c.status || 'Cancelación',
      })) || [],
    };
    segments.push(cancellationsSegment);
    console.log('🚪 Cancellations:', cancellationsSegment.count);

    // 3. NEW TRIALS
    const { data: newTrials } = await supabase
      .from('clients')
      .select('email, full_name, trial_started_at, status')
      .eq('lifecycle_stage', 'TRIAL')
      .gte('trial_started_at', last7Days);

    const trialsSegment: ActionableSegment = {
      segment: 'nuevos_trials',
      description: 'Usuarios que iniciaron trial en los últimos 7 días',
      count: newTrials?.length || 0,
      priority: 'medium',
      action: 'Enviar secuencia de onboarding y tips de uso',
      clients: newTrials?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        date: c.trial_started_at?.split('T')[0] || '',
      })) || [],
    };
    segments.push(trialsSegment);
    console.log('🆓 New trials:', trialsSegment.count);

    // 4. NEW CUSTOMERS
    const { data: newCustomers } = await supabase
      .from('clients')
      .select('email, full_name, converted_at, total_paid')
      .eq('lifecycle_stage', 'CUSTOMER')
      .gte('converted_at', last7Days);

    const conversionsSegment: ActionableSegment = {
      segment: 'conversiones_nuevas',
      description: 'Clientes que convirtieron a pago en los últimos 7 días',
      count: newCustomers?.length || 0,
      priority: 'medium',
      action: 'Enviar email de bienvenida y tutorial avanzado',
      clients: newCustomers?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        date: c.converted_at?.split('T')[0] || '',
        amount: c.total_paid || 0,
      })) || [],
    };
    segments.push(conversionsSegment);
    console.log('💳 New conversions:', conversionsSegment.count);

    // 5. NEW LEADS
    const { data: newLeads } = await supabase
      .from('clients')
      .select('email, full_name, created_at')
      .eq('lifecycle_stage', 'LEAD')
      .gte('created_at', last7Days);

    const leadsSegment: ActionableSegment = {
      segment: 'registros_nuevos',
      description: 'Leads nuevos que aún no han empezado trial',
      count: newLeads?.length || 0,
      priority: 'low',
      action: 'Enviar email de activación para iniciar trial',
      clients: newLeads?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        date: c.created_at?.split('T')[0] || '',
      })) || [],
    };
    segments.push(leadsSegment);
    console.log('📥 New leads:', leadsSegment.count);

    // 6. CHURN RISK
    const { data: expiringTrials } = await supabase
      .from('clients')
      .select('email, full_name, trial_started_at')
      .eq('lifecycle_stage', 'TRIAL')
      .lte('trial_started_at', new Date(today.getTime() - 11 * 24 * 60 * 60 * 1000).toISOString());

    const churnRiskSegment: ActionableSegment = {
      segment: 'riesgo_churn',
      description: 'Trials que expiran en los próximos 3 días sin conversión',
      count: expiringTrials?.length || 0,
      priority: 'high',
      action: 'Llamar o enviar oferta urgente de conversión',
      clients: expiringTrials?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        date: c.trial_started_at?.split('T')[0] || '',
        reason: 'Trial por expirar',
      })) || [],
    };
    segments.push(churnRiskSegment);
    console.log('⚠️ Churn risk:', churnRiskSegment.count);

    // 7. VIP CUSTOMERS
    const { data: topSpenders } = await supabase
      .from('clients')
      .select('email, full_name, total_paid')
      .eq('lifecycle_stage', 'CUSTOMER')
      .order('total_paid', { ascending: false })
      .limit(20);

    const vipSegment: ActionableSegment = {
      segment: 'clientes_vip',
      description: 'Top 20 clientes por valor total',
      count: topSpenders?.length || 0,
      priority: 'medium',
      action: 'Enviar contenido exclusivo y mantener relación',
      clients: topSpenders?.map(c => ({
        email: c.email || 'Desconocido',
        name: c.full_name || 'Sin nombre',
        amount: c.total_paid || 0,
      })) || [],
    };
    segments.push(vipSegment);
    console.log('👑 VIP customers:', vipSegment.count);

    // TODAY'S SALES
    const { data: todayTx } = await supabase
      .from('transactions')
      .select('amount, currency, status')
      .gte('stripe_created_at', startOfDay)
      .lt('stripe_created_at', endOfDay)
      .eq('status', 'paid');

    let totalSalesUSD = 0;
    let totalSalesMXN = 0;
    todayTx?.forEach(t => {
      if (t.currency?.toLowerCase() === 'mxn') {
        totalSalesMXN += t.amount / 100;
      } else {
        totalSalesUSD += t.amount / 100;
      }
    });

    const dailyMetrics: DailyMetrics = {
      date: today.toISOString().split('T')[0],
      summary: {
        totalSalesUSD,
        totalSalesMXN,
        transactionCount: todayTx?.length || 0,
        newSubscriptions: conversionsSegment.count,
        newTrials: trialsSegment.count,
        conversions: conversionsSegment.count,
        cancellations: cancellationsSegment.count,
        failedPayments: failedPaymentsSegment.count,
        churnRisk: churnRiskSegment.count,
      },
      segments,
    };

    console.log('🤖 Calling OpenAI for strategic analysis...');

    const aiPrompt = `Eres un consultor de negocios SaaS experto. Analiza estos datos del día y genera un reporte ejecutivo accionable.

MÉTRICAS DEL DÍA:
- Ventas hoy: $${totalSalesUSD.toFixed(2)} USD + $${totalSalesMXN.toFixed(2)} MXN (${todayTx?.length || 0} transacciones)
- Nuevos trials: ${trialsSegment.count}
- Nuevas conversiones: ${conversionsSegment.count}
- Cancelaciones: ${cancellationsSegment.count}
- Pagos fallidos: ${failedPaymentsSegment.count}
- Riesgo de churn: ${churnRiskSegment.count}
- Leads nuevos: ${leadsSegment.count}

SEGMENTOS DETALLADOS:
${JSON.stringify(segments.map(s => ({ 
  segmento: s.segment, 
  cantidad: s.count, 
  prioridad: s.priority,
  primeros3: s.clients.slice(0, 3).map(c => c.email)
})), null, 2)}

GENERA:
1. **Resumen Ejecutivo** (3-4 oraciones sobre el estado del negocio)
2. **Top 3 Acciones Prioritarias** para hoy (específicas y accionables)
3. **3 Oportunidades de Crecimiento** basadas en los datos
4. **3 Riesgos a Mitigar** con acciones preventivas

Responde en JSON:
{
  "summary": "Resumen ejecutivo...",
  "priorityActions": [
    {"action": "Acción específica", "segment": "segmento relacionado", "impact": "alto/medio/bajo"}
  ],
  "opportunities": [
    {"title": "Oportunidad", "description": "Descripción", "action": "Qué hacer"}
  ],
  "risks": [
    {"title": "Riesgo", "description": "Descripción", "prevention": "Acción preventiva"}
  ]
}`;

    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: 'Eres un consultor de negocios SaaS experto para DJs y productores musicales. Respondes siempre en JSON válido y en español.' 
          },
          { role: 'user', content: aiPrompt }
        ],
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('OpenAI API error:', aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ 
          error: 'Rate limit exceeded. Please try again later.',
          metrics: dailyMetrics,
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      throw new Error(`OpenAI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const aiContent = aiData.choices?.[0]?.message?.content || '';

    console.log('✅ OpenAI response received');

    let parsedInsights;
    try {
      parsedInsights = JSON.parse(aiContent);
    } catch {
      console.error('Error parsing AI response');
      parsedInsights = {
        summary: 'Análisis no disponible',
        priorityActions: [],
        opportunities: [],
        risks: [],
      };
    }

    const todayDate = today.toISOString().split('T')[0];
    
    const { data: insertedInsight, error: insertError } = await supabase
      .from('ai_insights')
      .upsert({
        date: todayDate,
        summary: parsedInsights.summary || 'No summary available',
        opportunities: parsedInsights.opportunities || [],
        risks: parsedInsights.risks || [],
        metrics: {
          ...dailyMetrics,
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

    console.log('💾 Insight saved successfully');

    return new Response(JSON.stringify({
      success: true,
      insight: insertedInsight,
      metrics: dailyMetrics,
      segments,
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
