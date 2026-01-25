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

interface ManyChatRequest {
  subscriber_id?: string;
  email?: string;
  phone?: string;
  message: string;
  client_id?: string;
  template?: 'friendly' | 'urgent' | 'final' | 'custom';
  client_name?: string;
  amount?: number;
  tag?: string;
}

serve(async (req) => {
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

    const MANYCHAT_API_KEY = Deno.env.get('MANYCHAT_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    if (!MANYCHAT_API_KEY) {
      console.error('Missing ManyChat API key');
      return new Response(
        JSON.stringify({ error: 'ManyChat API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const payload: ManyChatRequest = await req.json();
    console.log('ManyChat Request received:', { 
      email: payload.email, 
      phone: payload.phone,
      template: payload.template 
    });

    let message = payload.message;
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

    let subscriberId = payload.subscriber_id;

    if (!subscriberId && (payload.email || payload.phone)) {
      console.log('Searching for subscriber by email/phone...');
      
      if (payload.email) {
        const searchResponse = await fetch(
          `https://api.manychat.com/fb/subscriber/findBySystemField?field=email&value=${encodeURIComponent(payload.email)}`,
          {
            headers: {
              'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        const searchResult = await searchResponse.json();
        console.log('Email search result:', searchResult);
        
        if (searchResult.status === 'success' && searchResult.data?.id) {
          subscriberId = searchResult.data.id;
        }
      }
      
      if (!subscriberId && payload.phone) {
        const cleanPhone = payload.phone.replace(/[^\d+]/g, '');
        
        const searchResponse = await fetch(
          `https://api.manychat.com/fb/subscriber/findBySystemField?field=phone&value=${encodeURIComponent(cleanPhone)}`,
          {
            headers: {
              'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        const searchResult = await searchResponse.json();
        console.log('Phone search result:', searchResult);
        
        if (searchResult.status === 'success' && searchResult.data?.id) {
          subscriberId = searchResult.data.id;
        }
      }
    }

    if (!subscriberId) {
      console.log('Subscriber not found in ManyChat');
      return new Response(
        JSON.stringify({ 
          error: 'Subscriber not found in ManyChat',
          details: 'The email or phone is not registered as a ManyChat subscriber'
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Sending message to subscriber:', subscriberId);

    const sendResponse = await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            messages: [
              {
                type: 'text',
                text: message,
              }
            ]
          }
        }
      }),
    });

    const sendResult = await sendResponse.json();
    console.log('ManyChat send response:', sendResult);

    if (payload.tag && subscriberId) {
      await fetch('https://api.manychat.com/fb/subscriber/addTagByName', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscriber_id: subscriberId,
          tag_name: payload.tag,
        }),
      });
      console.log('Tag added:', payload.tag);
    }

    if (sendResult.status !== 'success') {
      console.error('ManyChat error:', sendResult);
      return new Response(
        JSON.stringify({ 
          error: 'Failed to send message', 
          details: sendResult.message || sendResult 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (payload.client_id) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      
      await supabase.from('client_events').insert({
        client_id: payload.client_id,
        event_type: 'email_sent',
        metadata: {
          channel: 'manychat',
          template: payload.template || 'custom',
          subscriber_id: subscriberId,
          tag: payload.tag,
        }
      });
      
      console.log('Event logged for client:', payload.client_id);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        subscriber_id: subscriberId,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in send-manychat:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
