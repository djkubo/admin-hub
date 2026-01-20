import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// ManyChat webhook payload structure
interface ManyChatPayload {
  id?: string;
  key?: string;
  subscriber_id?: string;
  
  // Contact info
  first_name?: string;
  last_name?: string;
  name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  
  // Attribution from custom fields
  source?: string;
  utm_source?: string;
  utm_campaign?: string;
  utm_medium?: string;
  utm_content?: string;
  
  // Custom user fields (ManyChat format)
  custom_fields?: Record<string, unknown>;
  
  // Tags
  tags?: Array<{ name: string }>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  
  console.log(`[${requestId}] receive-lead-manychat: Start`);

  try {
    // Security: Validate X-ADMIN-KEY header
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    const providedKey = req.headers.get('x-admin-key');
    
    if (!adminKey) {
      console.error(`[${requestId}] ADMIN_API_KEY not configured`);
      return new Response(
        JSON.stringify({ error: 'Service not configured', code: 'MISSING_SECRET' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (!providedKey || providedKey !== adminKey) {
      console.warn(`[${requestId}] Unauthorized request`);
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: ManyChatPayload = await req.json();
    const source = 'manychat';
    
    // Extract subscriber ID for idempotency
    const subscriberId = body.subscriber_id || body.id || body.key;
    if (!subscriberId) {
      return new Response(
        JSON.stringify({ error: 'subscriber_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const eventId = `mc_${subscriberId}_${Date.now()}`;
    
    console.log(`[${requestId}] ManyChat subscriber: ${subscriberId}, Email: ${body.email || 'N/A'}`);

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check for duplicate within last hour (same subscriber)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentEvent } = await supabase
      .from('lead_events')
      .select('id')
      .eq('source', source)
      .like('event_id', `mc_${subscriberId}_%`)
      .gte('processed_at', oneHourAgo)
      .maybeSingle();

    if (recentEvent) {
      console.log(`[${requestId}] Rate limited - recent event exists for subscriber ${subscriberId}`);
      return new Response(
        JSON.stringify({ success: true, action: 'skipped', reason: 'rate_limited' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normalize data
    const emailNormalized = body.email?.toLowerCase().trim();
    const phoneNormalized = normalizePhone(body.phone);
    const fullName = body.full_name || body.name || 
      (body.first_name && body.last_name ? `${body.first_name} ${body.last_name}` : 
       body.first_name || body.last_name || null);

    // Extract attribution
    const campaign = body.utm_campaign || body.custom_fields?.utm_campaign as string || null;
    const medium = body.utm_medium || body.custom_fields?.utm_medium as string || null;
    const content = body.utm_content || body.custom_fields?.utm_content as string || null;
    const utmSource = body.utm_source || body.custom_fields?.utm_source as string || 'manychat';

    // Extract tags
    const tags = body.tags?.map(t => t.name) || [];

    // Look for existing client
    let existingClient = null;
    
    // First by manychat_subscriber_id
    const { data: bySubId } = await supabase
      .from('clients')
      .select('*')
      .eq('manychat_subscriber_id', subscriberId)
      .maybeSingle();
    existingClient = bySubId;

    // Then by email
    if (!existingClient && emailNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .ilike('email', emailNormalized)
        .maybeSingle();
      existingClient = data;
    }
    
    // Finally by phone
    if (!existingClient && phoneNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .eq('phone', phoneNormalized)
        .maybeSingle();
      existingClient = data;
    }

    let clientId: string;
    let action: 'created' | 'updated';

    if (existingClient) {
      const updates: Record<string, unknown> = {};
      
      // Fill nulls only
      if (!existingClient.email && emailNormalized) updates.email = emailNormalized;
      if (!existingClient.phone && phoneNormalized) updates.phone = phoneNormalized;
      if (!existingClient.full_name && fullName) updates.full_name = fullName;
      if (!existingClient.manychat_subscriber_id) updates.manychat_subscriber_id = subscriberId;
      
      // Attribution - only first touch
      if (!existingClient.acquisition_source) updates.acquisition_source = utmSource;
      if (!existingClient.acquisition_campaign && campaign) updates.acquisition_campaign = campaign;
      if (!existingClient.acquisition_medium && medium) updates.acquisition_medium = medium;
      if (!existingClient.acquisition_content && content) updates.acquisition_content = content;
      
      // Merge tags
      if (tags.length > 0) {
        const existingTags = existingClient.tags || [];
        updates.tags = [...new Set([...existingTags, ...tags])];
      }

      // Update opt-in status
      updates.wa_opt_in = true;

      if (Object.keys(updates).length > 0) {
        updates.last_sync = new Date().toISOString();
        await supabase.from('clients').update(updates).eq('id', existingClient.id);
      }

      clientId = existingClient.id;
      action = 'updated';
    } else {
      const newClient = {
        email: emailNormalized,
        phone: phoneNormalized,
        full_name: fullName,
        lifecycle_stage: 'LEAD',
        status: 'active',
        acquisition_source: utmSource,
        acquisition_campaign: campaign,
        acquisition_medium: medium,
        acquisition_content: content,
        first_seen_at: new Date().toISOString(),
        manychat_subscriber_id: subscriberId,
        tags,
        wa_opt_in: true,
        customer_metadata: { manychat_raw: body },
      };

      const { data: created, error } = await supabase
        .from('clients')
        .insert(newClient)
        .select('id')
        .single();

      if (error) throw error;

      clientId = created.id;
      action = 'created';
    }

    // Record event
    await supabase.from('lead_events').insert({
      source,
      event_id: eventId,
      event_type: action === 'created' ? 'lead_created' : 'lead_updated',
      client_id: clientId,
      payload: body,
    });

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Completed in ${duration}ms - ${action} client ${clientId}`);

    return new Response(
      JSON.stringify({ success: true, action, client_id: clientId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error(`[${requestId}] Error:`, error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '52' + digits;
  return '+' + digits;
}
