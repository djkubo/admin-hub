import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// SECURITY: JWT + is_admin() verification
async function verifyAdmin(req: Request): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } }
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return { valid: false, error: 'Invalid token' };
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin');
  if (adminError || !isAdmin) {
    return { valid: false, error: 'Not authorized as admin' };
  }

  return { valid: true, userId: user.id };
}

interface TriggerPayload {
  trigger_event: 'payment_failed' | 'trial_started' | 'trial_end_24h' | 'canceled' | 'invoice_open';
  client_id: string;
  revenue_at_risk?: number;
  metadata?: Record<string, unknown>;
}

const messageTemplates = {
  payment_failed: {
    friendly: (name: string, amount: string) => 
      `Hola ${name} 👋 Notamos que tu pago de ${amount} no se procesó. ¿Te podemos ayudar? Responde aquí.`,
    urgent: (name: string, amount: string) => 
      `⚠️ ${name}, tu pago de ${amount} falló. Para evitar suspensión, actualiza tu método de pago hoy.`,
    final: (name: string, amount: string) => 
      `🚨 ÚLTIMO AVISO ${name}: Servicio será suspendido en 24h por falta de pago (${amount}).`,
  },
  trial_started: {
    friendly: (name: string) => 
      `¡Bienvenido ${name}! 🎉 Tu prueba gratuita está activa. ¿Tienes dudas? Escríbenos.`,
    urgent: (name: string) => `¡Hola ${name}! Tu trial está listo. ¡Aprovéchalo!`,
    final: (name: string) => `${name}, tu prueba está activa. ¡No te lo pierdas!`,
  },
  trial_end_24h: {
    friendly: (name: string) => 
      `Hola ${name}, tu prueba termina mañana. ¿Listo para continuar? Te ayudamos con el upgrade.`,
    urgent: (name: string) => 
      `⏰ ${name}, quedan 24h de tu trial. Activa tu plan ahora para no perder acceso.`,
    final: (name: string) => 
      `🚨 ${name}, última oportunidad: tu prueba expira HOY. Activa tu plan ahora.`,
  },
  canceled: {
    friendly: (name: string) => 
      `Hola ${name}, lamentamos verte partir 😢 ¿Hay algo que podamos mejorar? Tu feedback es valioso.`,
    urgent: (name: string) => 
      `${name}, notamos que cancelaste. ¿Fue un error? Podemos ayudarte a reactivar.`,
    final: (name: string) => 
      `${name}, te extrañamos. Tenemos una oferta especial para ti. ¿Hablamos?`,
  },
  invoice_open: {
    friendly: (name: string, amount: string) => 
      `Hola ${name}, tienes una factura pendiente de ${amount}. ¿Te ayudamos con el pago?`,
    urgent: (name: string, amount: string) => 
      `${name}, recordatorio: factura de ${amount} pendiente. Evita cargos adicionales.`,
    final: (name: string, amount: string) => 
      `⚠️ ${name}, factura de ${amount} vencida. Regulariza tu cuenta hoy.`,
  },
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify JWT + is_admin()
    const authCheck = await verifyAdmin(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log("✅ Admin verified via JWT");

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const payload: TriggerPayload = await req.json();
    console.log('Campaign trigger received:', payload);

    const { data: rule, error: ruleError } = await supabase
      .from('campaign_rules')
      .select('*')
      .eq('trigger_event', payload.trigger_event)
      .eq('is_active', true)
      .single();

    if (ruleError || !rule) {
      console.log('No active rule for event:', payload.trigger_event);
      return new Response(
        JSON.stringify({ message: 'No active rule for this event' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', payload.client_id)
      .single();

    if (clientError || !client) {
      console.error('Client not found:', payload.client_id);
      return new Response(
        JSON.stringify({ error: 'Client not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('*')
      .eq('client_id', client.id)
      .or('channel.eq.all,channel.in.(whatsapp,sms,manychat,ghl)')
      .limit(1);

    if (optOut && optOut.length > 0) {
      console.log('Client opted out:', client.id);
      const { error: execError } = await supabase.from('campaign_executions').insert({
        rule_id: rule.id,
        client_id: client.id,
        trigger_event: payload.trigger_event,
        status: 'opted_out',
        revenue_at_risk: payload.revenue_at_risk || 0,
        metadata: payload.metadata,
      });
      if (execError) console.error('Error logging opted_out execution:', execError);
      return new Response(
        JSON.stringify({ message: 'Client opted out' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: recentCampaigns } = await supabase
      .from('campaign_executions')
      .select('*')
      .eq('client_id', client.id)
      .eq('trigger_event', payload.trigger_event)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false });

    if (recentCampaigns && recentCampaigns.length >= rule.max_attempts) {
      console.log('Max attempts reached for client:', client.id);
      return new Response(
        JSON.stringify({ message: 'Max attempts reached in 24h' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const clientName = client.full_name || 'Cliente';
    const amount = payload.revenue_at_risk 
      ? `$${(payload.revenue_at_risk / 100).toFixed(2)}` 
      : '';
    
    const templateFn = messageTemplates[payload.trigger_event]?.[rule.template_type as keyof typeof messageTemplates.payment_failed];
    const message = templateFn 
      ? (payload.trigger_event === 'trial_started' || payload.trigger_event === 'canceled' || payload.trigger_event === 'trial_end_24h'
          ? (templateFn as (name: string) => string)(clientName)
          : (templateFn as (name: string, amount: string) => string)(clientName, amount))
      : `Hola ${clientName}, tenemos un mensaje importante para ti.`;

    const channelPriority = rule.channel_priority || ['whatsapp', 'sms', 'manychat', 'ghl'];
    let successChannel: string | null = null;
    let externalMessageId: string | null = null;

    for (const channel of channelPriority) {
      try {
        if (channel === 'whatsapp' && client.phone) {
          const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
          const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
          const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER');

          if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
            let phoneNumber = client.phone.replace(/[^\d+]/g, '');
            if (!phoneNumber.startsWith('+')) {
              phoneNumber = phoneNumber.length === 10 ? '+1' + phoneNumber : '+' + phoneNumber;
            }

            const whatsappTo = `whatsapp:${phoneNumber}`;
            const whatsappFrom = `whatsapp:${TWILIO_PHONE_NUMBER}`;

            const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
            const formData = new URLSearchParams();
            formData.append('To', whatsappTo);
            formData.append('From', whatsappFrom);
            formData.append('Body', message);

            const response = await fetch(twilioUrl, {
              method: 'POST',
              headers: {
                'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: formData.toString(),
            });

            const result = await response.json();
            if (response.ok && result.sid) {
              successChannel = 'whatsapp';
              externalMessageId = result.sid;
              console.log('WhatsApp sent successfully:', result.sid);
              break;
            }
          }
        }

        if (channel === 'sms' && client.phone) {
          const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
          const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
          const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER');

          if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER) {
            let phoneNumber = client.phone.replace(/[^\d+]/g, '');
            if (!phoneNumber.startsWith('+')) {
              phoneNumber = phoneNumber.length === 10 ? '+1' + phoneNumber : '+' + phoneNumber;
            }

            const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
            const formData = new URLSearchParams();
            formData.append('To', phoneNumber);
            formData.append('From', TWILIO_PHONE_NUMBER);
            formData.append('Body', message);

            const response = await fetch(twilioUrl, {
              method: 'POST',
              headers: {
                'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: formData.toString(),
            });

            const result = await response.json();
            if (response.ok && result.sid) {
              successChannel = 'sms';
              externalMessageId = result.sid;
              console.log('SMS sent successfully:', result.sid);
              break;
            }
          }
        }

        if (channel === 'manychat') {
          const MANYCHAT_API_KEY = Deno.env.get('MANYCHAT_API_KEY');
          if (MANYCHAT_API_KEY && (client.email || client.phone)) {
            const searchField = client.email ? 'email' : 'phone';
            const searchValue = client.email || client.phone?.replace(/[^\d+]/g, '');

            const searchResponse = await fetch(
              `https://api.manychat.com/fb/subscriber/findBySystemField?field=${searchField}&value=${encodeURIComponent(searchValue!)}`,
              { headers: { 'Authorization': `Bearer ${MANYCHAT_API_KEY}` } }
            );
            const searchResult = await searchResponse.json();

            if (searchResult.status === 'success' && searchResult.data?.id) {
              const sendResponse = await fetch('https://api.manychat.com/fb/sending/sendContent', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  subscriber_id: searchResult.data.id,
                  data: {
                    version: 'v2',
                    content: { messages: [{ type: 'text', text: message }] }
                  }
                }),
              });
              const sendResult = await sendResponse.json();
              if (sendResult.status === 'success') {
                successChannel = 'manychat';
                externalMessageId = searchResult.data.id;
                console.log('ManyChat sent successfully');
                break;
              }
            }
          }
        }

        if (channel === 'ghl') {
          const { data: ghlSetting } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'ghl_webhook_url')
            .single();

          if (ghlSetting?.value) {
            const ghlPayload = {
              email: client.email,
              phone: client.phone,
              name: client.full_name,
              tags: [payload.trigger_event],
              customField: { 
                message_content: message,
                revenue_at_risk: payload.revenue_at_risk,
              }
            };

            const response = await fetch(ghlSetting.value, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(ghlPayload),
            });

            if (response.ok) {
              successChannel = 'ghl';
              console.log('GHL notification sent');
              break;
            }
          }
        }
      } catch (e) {
        console.error(`Error with channel ${channel}:`, e);
        continue;
      }
    }

    const execution = {
      rule_id: rule.id,
      client_id: client.id,
      trigger_event: payload.trigger_event,
      channel_used: successChannel,
      status: successChannel ? 'sent' : 'failed',
      attempt_number: (recentCampaigns?.length || 0) + 1,
      message_content: message,
      external_message_id: externalMessageId,
      revenue_at_risk: payload.revenue_at_risk || 0,
      metadata: payload.metadata,
    };

    const { error: execInsertError } = await supabase.from('campaign_executions').insert(execution);
    if (execInsertError) console.error('Error inserting campaign execution:', execInsertError);

    const { error: eventInsertError } = await supabase.from('client_events').insert({
      client_id: client.id,
      event_type: successChannel ? 'email_sent' : 'custom',
      metadata: {
        channel: successChannel || 'none',
        trigger_event: payload.trigger_event,
        message_id: externalMessageId,
        campaign_rule: rule.name,
      }
    });
    if (eventInsertError) console.error('Error inserting client event:', eventInsertError);

    const newScore = (client.revenue_score || 0) + (payload.revenue_at_risk ? 1 : 0);
    const { error: scoreUpdateError } = await supabase
      .from('clients')
      .update({ revenue_score: newScore })
      .eq('id', client.id);
    if (scoreUpdateError) console.error('Error updating revenue score:', scoreUpdateError);

    return new Response(
      JSON.stringify({ 
        success: !!successChannel,
        channel: successChannel,
        message_id: externalMessageId,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in execute-campaign:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
