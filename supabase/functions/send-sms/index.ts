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

interface SMSRequest {
  to: string;
  message?: string;
  client_id?: string;
  template?: 'friendly' | 'urgent' | 'final' | 'custom';
  client_name?: string;
  amount?: number;
  channel?: 'sms' | 'whatsapp';
  // Support for Twilio Content Templates (approved templates)
  content_sid?: string;
  content_variables?: Record<string, string>;
  // Messaging Service support
  messaging_service_sid?: string;
}

Deno.serve(async (req) => {
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

    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
    const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.error('Missing Twilio credentials');
      return new Response(
        JSON.stringify({ error: 'Twilio credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const payload: SMSRequest = await req.json();
    const channel = payload.channel || 'sms';
    console.log('SMS Request received:', { 
      to: payload.to, 
      template: payload.template, 
      channel,
      content_sid: payload.content_sid,
    });

    let phoneNumber = payload.to.replace(/[^\d+]/g, '');
    
    if (!phoneNumber.startsWith('+')) {
      if (phoneNumber.length === 10) {
        phoneNumber = '+1' + phoneNumber;
      } else if (phoneNumber.length === 11 && phoneNumber.startsWith('1')) {
        phoneNumber = '+' + phoneNumber;
      } else {
        phoneNumber = '+' + phoneNumber;
      }
    }

    // Format for WhatsApp: whatsapp:+1234567890
    const toAddress = channel === 'whatsapp' ? `whatsapp:${phoneNumber}` : phoneNumber;
    
    // Get the appropriate "From" number for the channel
    const TWILIO_WHATSAPP_NUMBER = Deno.env.get('TWILIO_WHATSAPP_NUMBER') || `whatsapp:${TWILIO_PHONE_NUMBER}`;
    const fromAddress = channel === 'whatsapp' ? TWILIO_WHATSAPP_NUMBER : TWILIO_PHONE_NUMBER;

    console.log(`Sending ${channel.toUpperCase()} to:`, toAddress, 'from:', fromAddress);

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    
    const formData = new URLSearchParams();
    formData.append('To', toAddress);
    
    // Use MessagingServiceSid if provided, otherwise use From
    if (payload.messaging_service_sid) {
      formData.append('MessagingServiceSid', payload.messaging_service_sid);
      console.log('Using MessagingServiceSid:', payload.messaging_service_sid);
    } else if (fromAddress) {
      formData.append('From', fromAddress);
    }

    // If using Content Template (approved WhatsApp templates)
    if (payload.content_sid) {
      formData.append('ContentSid', payload.content_sid);
      console.log('Using ContentSid:', payload.content_sid);
      
      if (payload.content_variables) {
        formData.append('ContentVariables', JSON.stringify(payload.content_variables));
        console.log('ContentVariables:', payload.content_variables);
      }
    } else {
      // Build message from template or custom message
      let message = payload.message || '';
      
      if (payload.template && payload.template !== 'custom') {
        const name = payload.client_name || 'Cliente';
        const amount = payload.amount ? `$${(payload.amount / 100).toFixed(2)}` : '';
        
        switch (payload.template) {
          case 'friendly':
            message = `Hola ${name} 👋 Notamos que tu pago de ${amount} no se procesó correctamente. ¿Podemos ayudarte a resolverlo? Responde a este mensaje.`;
            break;
          case 'urgent':
            message = `⚠️ ${name}, tu cuenta tiene un pago pendiente de ${amount}. Para evitar la suspensión del servicio, actualiza tu método de pago hoy.`;
            break;
          case 'final':
            message = `🚨 ÚLTIMO AVISO: ${name}, tu servicio será suspendido en 24h por falta de pago (${amount}). Contáctanos urgentemente para evitarlo.`;
            break;
        }
      }
      
      if (!message) {
        return new Response(
          JSON.stringify({ error: 'Message body or content_sid is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      formData.append('Body', message);
    }

    console.log('Sending to Twilio API...');

    const twilioResponse = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const twilioResult = await twilioResponse.json();
    console.log('Twilio response:', twilioResult);

    if (!twilioResponse.ok) {
      console.error('Twilio error:', twilioResult);
      return new Response(
        JSON.stringify({ 
          error: 'Failed to send message', 
          details: twilioResult.message || twilioResult,
          code: twilioResult.code,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Always store outbound messages in messages table
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Build message body for storage
    let messageBody = payload.message || '';
    if (payload.content_sid) {
      messageBody = `[Template: ${payload.content_sid}]`;
      if (payload.content_variables) {
        messageBody += ` Variables: ${JSON.stringify(payload.content_variables)}`;
      }
    } else if (payload.template && payload.template !== 'custom') {
      const name = payload.client_name || 'Cliente';
      const amount = payload.amount ? `$${(payload.amount / 100).toFixed(2)}` : '';
      switch (payload.template) {
        case 'friendly':
          messageBody = `Hola ${name} 👋 Notamos que tu pago de ${amount} no se procesó correctamente. ¿Podemos ayudarte a resolverlo? Responde a este mensaje.`;
          break;
        case 'urgent':
          messageBody = `⚠️ ${name}, tu cuenta tiene un pago pendiente de ${amount}. Para evitar la suspensión del servicio, actualiza tu método de pago hoy.`;
          break;
        case 'final':
          messageBody = `🚨 ÚLTIMO AVISO: ${name}, tu servicio será suspendido en 24h por falta de pago (${amount}). Contáctanos urgentemente para evitarlo.`;
          break;
      }
    }

    // Store the outbound message
    const { error: msgError } = await supabase.from('messages').insert({
      client_id: payload.client_id || null,
      direction: 'outbound',
      channel: channel,
      from_address: twilioResult.from || fromAddress,
      to_address: phoneNumber,
      body: messageBody,
      external_message_id: twilioResult.sid,
      status: twilioResult.status || 'queued',
      metadata: {
        template: payload.template || null,
        content_sid: payload.content_sid || null,
        messaging_service_sid: payload.messaging_service_sid || null,
      },
    });

    if (msgError) {
      console.error('Error storing outbound message:', msgError);
    } else {
      console.log('✅ Outbound message stored in messages table');
    }

    // Log client event if client_id provided
    if (payload.client_id) {
      await supabase.from('client_events').insert({
        client_id: payload.client_id,
        event_type: 'email_sent',
        metadata: {
          channel: channel,
          template: payload.template || payload.content_sid || 'custom',
          phone: phoneNumber,
          message_sid: twilioResult.sid,
          status: twilioResult.status,
        }
      });
      
      console.log('Event logged for client:', payload.client_id);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message_sid: twilioResult.sid,
        status: twilioResult.status,
        to: toAddress,
        from: twilioResult.from,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in send-sms:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
