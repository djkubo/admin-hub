import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// GoHighLevel webhook payload
interface GHLPayload {
  id?: string;
  contact_id?: string;
  contactId?: string;
  
  // Contact info
  firstName?: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  name?: string;
  email?: string;
  phone?: string;
  
  // Attribution
  source?: string;
  tags?: string[];
  
  // Custom fields
  customField?: Record<string, unknown>;
  customFields?: Array<{ id: string; key: string; value: string }>;
  
  // Event type
  event?: string;
  type?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  
  console.log(`[${requestId}] receive-lead-ghl: Start`);

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

    const body: GHLPayload = await req.json();
    const source = 'ghl';
    
    // Extract GHL contact ID
    const contactId = body.contact_id || body.contactId || body.id;
    if (!contactId) {
      return new Response(
        JSON.stringify({ error: 'contact_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const eventType = body.event || body.type || 'contact_update';
    const eventId = `ghl_${contactId}_${eventType}_${Date.now()}`;
    
    console.log(`[${requestId}] GHL contact: ${contactId}, Event: ${eventType}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Rate limit - 1 event per contact per minute
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: recentEvent } = await supabase
      .from('lead_events')
      .select('id')
      .eq('source', source)
      .like('event_id', `ghl_${contactId}_%`)
      .gte('processed_at', oneMinuteAgo)
      .maybeSingle();

    if (recentEvent) {
      console.log(`[${requestId}] Rate limited - recent event for contact ${contactId}`);
      return new Response(
        JSON.stringify({ success: true, action: 'skipped', reason: 'rate_limited' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Normalize data
    const emailNormalized = body.email?.toLowerCase().trim();
    const phoneNormalized = normalizePhone(body.phone);
    const fullName = body.name || 
      ((body.firstName || body.first_name) && (body.lastName || body.last_name) 
        ? `${body.firstName || body.first_name} ${body.lastName || body.last_name}` 
        : body.firstName || body.first_name || body.lastName || body.last_name || null);

    // Extract custom fields for attribution
    let campaign: string | null = null;
    let medium: string | null = null;
    let content: string | null = null;
    
    if (body.customFields) {
      for (const field of body.customFields) {
        if (field.key === 'utm_campaign') campaign = field.value;
        if (field.key === 'utm_medium') medium = field.value;
        if (field.key === 'utm_content') content = field.value;
      }
    } else if (body.customField) {
      campaign = body.customField.utm_campaign as string || null;
      medium = body.customField.utm_medium as string || null;
      content = body.customField.utm_content as string || null;
    }

    const ghlSource = body.source || 'ghl';
    const tags = body.tags || [];

    // Look for existing client
    let existingClient = null;
    
    // First by ghl_contact_id
    const { data: byGhlId } = await supabase
      .from('clients')
      .select('*')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    existingClient = byGhlId;

    if (!existingClient && emailNormalized) {
      const { data } = await supabase
        .from('clients')
        .select('*')
        .ilike('email', emailNormalized)
        .maybeSingle();
      existingClient = data;
    }
    
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
      
      if (!existingClient.email && emailNormalized) updates.email = emailNormalized;
      if (!existingClient.phone && phoneNormalized) updates.phone = phoneNormalized;
      if (!existingClient.full_name && fullName) updates.full_name = fullName;
      if (!existingClient.ghl_contact_id) updates.ghl_contact_id = contactId;
      
      if (!existingClient.acquisition_source) updates.acquisition_source = ghlSource;
      if (!existingClient.acquisition_campaign && campaign) updates.acquisition_campaign = campaign;
      if (!existingClient.acquisition_medium && medium) updates.acquisition_medium = medium;
      if (!existingClient.acquisition_content && content) updates.acquisition_content = content;
      
      if (tags.length > 0) {
        const existingTags = existingClient.tags || [];
        updates.tags = [...new Set([...existingTags, ...tags])];
      }

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
        acquisition_source: ghlSource,
        acquisition_campaign: campaign,
        acquisition_medium: medium,
        acquisition_content: content,
        first_seen_at: new Date().toISOString(),
        ghl_contact_id: contactId,
        tags,
        customer_metadata: { ghl_raw: body },
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
