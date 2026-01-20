import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface GHLNotification {
  email: string;
  phone?: string | null;
  name?: string | null;
  tag: 'payment_failed' | 'new_lead' | 'manual_push' | 'trial_started' | 'churn_risk' | string;
  message_data?: Record<string, unknown>;
}

/**
 * Edge Function: notify-ghl
 * 
 * Sends client data to GoHighLevel via webhook.
 * Used for:
 * - payment_failed: When a payment fails (Stripe webhook, CSV import)
 * - new_lead: When a new user without purchases is detected
 * - manual_push: Manual button in Clients table
 * - trial_started: When a trial subscription starts
 * - churn_risk: When system detects churn indicators
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const payload: GHLNotification = await req.json();
    console.log(`📤 notify-ghl called with tag: ${payload.tag}, email: ${payload.email}`);

    if (!payload.email) {
      return new Response(
        JSON.stringify({ error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch webhook URL from system_settings
    const { data: setting, error: settingError } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'ghl_webhook_url')
      .single();

    if (settingError || !setting?.value) {
      console.warn('⚠️ GHL webhook URL not configured in system_settings');
      return new Response(
        JSON.stringify({ 
          error: 'GHL webhook URL not configured',
          hint: 'Set ghl_webhook_url in system_settings table'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const webhookUrl = setting.value;
    console.log(`🔗 Using webhook URL: ${webhookUrl.substring(0, 50)}...`);

    // Prepare GHL payload
    const ghlPayload = {
      // Contact fields
      email: payload.email,
      phone: payload.phone || '',
      name: payload.name || payload.email.split('@')[0],
      firstName: payload.name?.split(' ')[0] || '',
      lastName: payload.name?.split(' ').slice(1).join(' ') || '',
      
      // Tags for automation
      tags: [payload.tag],
      
      // Custom fields for context
      customField: {
        tag: payload.tag,
        source: 'lovable_crm',
        timestamp: new Date().toISOString(),
        ...payload.message_data
      },
      
      // Location ID for GHL
      locationId: ghlLocationId || undefined
    };

    console.log(`📦 Sending to GHL:`, JSON.stringify(ghlPayload, null, 2));

    // Send to GHL webhook
    const ghlHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add API key if available (for direct API calls)
    if (ghlApiKey) {
      ghlHeaders['Authorization'] = `Bearer ${ghlApiKey}`;
    }

    const ghlResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: ghlHeaders,
      body: JSON.stringify(ghlPayload),
    });

    const ghlResponseText = await ghlResponse.text();
    console.log(`📥 GHL response (${ghlResponse.status}):`, ghlResponseText);

    if (!ghlResponse.ok) {
      console.error(`❌ GHL webhook failed: ${ghlResponse.status} - ${ghlResponseText}`);
      return new Response(
        JSON.stringify({ 
          error: 'GHL webhook failed',
          status: ghlResponse.status,
          response: ghlResponseText 
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Log event to client_events for tracking
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('email', payload.email)
      .single();

    if (client) {
      await supabase
        .from('client_events')
        .insert({
          client_id: client.id,
          event_type: 'custom',
          metadata: {
            action: 'ghl_notification',
            tag: payload.tag,
            webhook_url: webhookUrl.substring(0, 50),
            timestamp: new Date().toISOString()
          }
        });
      console.log(`📝 Event logged for client: ${client.id}`);
    }

    console.log(`✅ Successfully sent ${payload.tag} notification for ${payload.email}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        tag: payload.tag,
        email: payload.email,
        ghl_response: ghlResponseText
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ notify-ghl error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
