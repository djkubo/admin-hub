import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// deno-lint-ignore no-explicit-any
type SupabaseClient = ReturnType<typeof createClient<any>>;

interface ManyChatSubscriber {
  id: string;
  email?: string;
  phone?: string;
  whatsapp_phone?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  tags?: Array<{ name: string; id?: number } | string>;
  optin_email?: boolean;
  optin_sms?: boolean;
  optin_whatsapp?: boolean;
  custom_fields?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  subscribed?: string;
  last_interaction?: string;
}

interface ManyChatTag {
  id: number;
  name: string;
}

const logger = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[WARN] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
};

// Rate limiter: 10 requests per second, with pause between bursts
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_PAUSE_MS = 1100; // Pause 1.1s after each burst

async function rateLimitedBatch<T, R>(
  items: T[],
  processFn: (item: T) => Promise<R>,
  batchSize: number = RATE_LIMIT_REQUESTS
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
    
    // Pause between batches to respect rate limits
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_PAUSE_MS));
    }
  }
  
  return results;
}

// Fetch all tags from ManyChat page
async function fetchAllTags(apiKey: string): Promise<ManyChatTag[]> {
  logger.info('Fetching all tags from ManyChat');
  
  const response = await fetch('https://api.manychat.com/fb/page/getTags', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to fetch tags', { status: response.status, error: errorText });
    throw new Error(`Failed to fetch tags: ${response.status}`);
  }
  
  const data = await response.json();
  const tags = data?.data || [];
  logger.info(`Found ${tags.length} tags in ManyChat`);
  
  return tags;
}

// Fetch subscribers by tag ID
async function fetchSubscribersByTag(apiKey: string, tagId: number, tagName: string): Promise<ManyChatSubscriber[]> {
  logger.info(`Fetching subscribers for tag: ${tagName} (ID: ${tagId})`);
  
  try {
    const response = await fetch(
      `https://api.manychat.com/fb/subscriber/findByCustomField`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          field_name: 'tag',
          field_value: tagName,
        }),
      }
    );
    
    if (!response.ok) {
      // Try alternative endpoint
      const altResponse = await fetch(
        `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=tag&field_value=${encodeURIComponent(tagName)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
      
      if (!altResponse.ok) {
        logger.warn(`Could not fetch subscribers for tag ${tagName}`, { status: altResponse.status });
        return [];
      }
      
      const altData = await altResponse.json();
      return altData?.data ? [altData.data] : [];
    }
    
    const data = await response.json();
    const subscribers = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
    logger.info(`Found ${subscribers.length} subscribers for tag ${tagName}`);
    
    return subscribers;
  } catch (error) {
    logger.warn(`Error fetching subscribers for tag ${tagName}`, { error: String(error) });
    return [];
  }
}

// Main function to fetch ALL subscribers using tags as proxy
async function fetchAllSubscribersViaTagsStrategy(
  apiKey: string,
  supabase: SupabaseClient
): Promise<{ total: number; stored: number }> {
  logger.info('=== Starting Tag-Based Subscriber Fetch ===');
  
  // Step 1: Get all tags
  const tags = await fetchAllTags(apiKey);
  
  if (tags.length === 0) {
    logger.warn('No tags found - cannot use tag-based strategy');
    return { total: 0, stored: 0 };
  }
  
  // Step 2: Fetch subscribers for each tag with rate limiting
  const allSubscribers = new Map<string, ManyChatSubscriber>();
  
  for (const tag of tags) {
    const subscribers = await fetchSubscribersByTag(apiKey, tag.id, tag.name);
    
    for (const sub of subscribers) {
      if (sub.id && !allSubscribers.has(sub.id)) {
        allSubscribers.set(sub.id, sub);
      }
    }
    
    // Rate limit pause between tag fetches
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  logger.info(`Total unique subscribers found via tags: ${allSubscribers.size}`);
  
  // Step 3: Store in manychat_contacts_raw
  const subscribersArray = Array.from(allSubscribers.values());
  let storedCount = 0;
  
  const BATCH_SIZE = 50;
  for (let i = 0; i < subscribersArray.length; i += BATCH_SIZE) {
    const batch = subscribersArray.slice(i, i + BATCH_SIZE);
    
    const records = batch.map(sub => ({
      subscriber_id: sub.id,
      email: sub.email?.toLowerCase()?.trim() || null,
      phone: sub.phone || sub.whatsapp_phone || null,
      first_name: sub.first_name || null,
      last_name: sub.last_name || null,
      name: sub.name || `${sub.first_name || ''} ${sub.last_name || ''}`.trim() || null,
      tags: sub.tags?.map(t => typeof t === 'string' ? t : t.name) || [],
      raw_payload: sub,
      fetched_at: new Date().toISOString(),
      source: 'tags_strategy',
    }));
    
    // Use delete/insert pattern to avoid constraint conflicts
    const subscriberIds = records.map(r => r.subscriber_id);
    
    await supabase
      .from('manychat_contacts_raw')
      .delete()
      .in('subscriber_id', subscriberIds);
    
    const { error } = await supabase
      .from('manychat_contacts_raw')
      .insert(records);
    
    if (error) {
      logger.error('Error inserting batch', { error: error.message, batch: i });
    } else {
      storedCount += records.length;
    }
  }
  
  logger.info(`=== Tag Strategy Complete: ${storedCount} stored ===`);
  return { total: allSubscribers.size, stored: storedCount };
}

// Original email-based lookup (improved with better parallelism)
async function fetchSubscriberByEmail(
  apiKey: string,
  email: string
): Promise<ManyChatSubscriber | null> {
  try {
    const response = await fetch(
      `https://api.manychat.com/fb/subscriber/findBySystemField?field_name=email&field_value=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data?.data || null;
  } catch {
    return null;
  }
}

// Process clients by email lookup (legacy but optimized)
async function processEmailLookup(
  apiKey: string,
  supabase: SupabaseClient,
  limit: number = 500
): Promise<{ processed: number; found: number; stored: number }> {
  logger.info('=== Starting Email Lookup Strategy ===');
  
  // Get clients without manychat_subscriber_id
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, email')
    .is('manychat_subscriber_id', null)
    .not('email', 'is', null)
    .limit(limit);
  
  if (error || !clients?.length) {
    logger.info('No clients need ManyChat lookup', { error: error?.message });
    return { processed: 0, found: 0, stored: 0 };
  }
  
  logger.info(`Processing ${clients.length} clients via email lookup`);
  
  let found = 0;
  let stored = 0;
  
  // Process with improved parallelism (10 at a time)
  const results = await rateLimitedBatch(
    clients,
    async (client) => {
      if (!client.email) return null;
      
      const subscriber = await fetchSubscriberByEmail(apiKey, client.email);
      
      if (subscriber) {
        // Store in raw table
        const record = {
          subscriber_id: subscriber.id,
          email: subscriber.email?.toLowerCase()?.trim() || null,
          phone: subscriber.phone || subscriber.whatsapp_phone || null,
          first_name: subscriber.first_name || null,
          last_name: subscriber.last_name || null,
          name: subscriber.name || `${subscriber.first_name || ''} ${subscriber.last_name || ''}`.trim() || null,
          tags: subscriber.tags?.map(t => typeof t === 'string' ? t : t.name) || [],
          raw_payload: subscriber,
          fetched_at: new Date().toISOString(),
          source: 'email_lookup',
        };
        
        // Delete existing to avoid conflicts
        await supabase
          .from('manychat_contacts_raw')
          .delete()
          .eq('subscriber_id', subscriber.id);
        
        const { error: insertError } = await supabase
          .from('manychat_contacts_raw')
          .insert(record);
        
        if (!insertError) {
          // Update client with subscriber ID
          await supabase
            .from('clients')
            .update({ 
              manychat_subscriber_id: subscriber.id,
              last_sync: new Date().toISOString()
            })
            .eq('id', client.id);
          
          return { found: true, stored: true };
        }
        
        return { found: true, stored: false };
      }
      
      return null;
    },
    RATE_LIMIT_REQUESTS
  );
  
  for (const result of results) {
    if (result?.found) found++;
    if (result?.stored) stored++;
  }
  
  logger.info(`=== Email Lookup Complete: ${found} found, ${stored} stored ===`);
  return { processed: clients.length, found, stored };
}

// Check if paused
async function checkIfPaused(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'manychat_paused')
    .maybeSingle();
  
  return data?.value === true || data?.value === 'true';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const manychatApiKey = Deno.env.get('MANYCHAT_API_KEY');
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  try {
    const body = await req.json().catch(() => ({}));
    
    // Test-only mode: quick API verification
    if (body.testOnly === true) {
      logger.info('Test-only mode: Verifying ManyChat API connection');
      
      if (!manychatApiKey) {
        return new Response(JSON.stringify({
          ok: false,
          success: false,
          error: 'MANYCHAT_API_KEY not configured',
          testOnly: true
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // Quick test: fetch page info
      const testResponse = await fetch('https://api.manychat.com/fb/page/getInfo', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${manychatApiKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      const isOk = testResponse.ok;
      
      return new Response(JSON.stringify({
        ok: isOk,
        success: isOk,
        status: isOk ? 'connected' : 'error',
        apiStatus: testResponse.status,
        testOnly: true
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Check kill switch
    const isPaused = await checkIfPaused(supabase);
    if (isPaused) {
      logger.info('ManyChat sync is paused via kill switch');
      return new Response(JSON.stringify({
        ok: false,
        error: 'ManyChat sincronización está pausada. Actívala en Configuración del Sistema.',
        paused: true
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    if (!manychatApiKey) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'MANYCHAT_API_KEY not configured'
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    const mode = body.mode || 'stageOnly';
    const strategy = body.strategy || 'tags'; // 'tags' or 'email_lookup'
    
    logger.info(`Starting ManyChat sync: mode=${mode}, strategy=${strategy}`);
    
    let result;
    
    if (strategy === 'tags') {
      // NEW: Tag-based strategy to fetch ALL subscribers
      result = await fetchAllSubscribersViaTagsStrategy(manychatApiKey, supabase);
      
      return new Response(JSON.stringify({
        ok: true,
        success: true,
        strategy: 'tags',
        mode,
        total: result.total,
        stored: result.stored,
        message: `Fetched ${result.total} subscribers via tags, stored ${result.stored} in staging`
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      
    } else {
      // Legacy: Email lookup strategy
      result = await processEmailLookup(manychatApiKey, supabase, body.limit || 500);
      
      return new Response(JSON.stringify({
        ok: true,
        success: true,
        strategy: 'email_lookup',
        mode,
        processed: result.processed,
        found: result.found,
        stored: result.stored,
        message: `Processed ${result.processed} clients, found ${result.found} in ManyChat`
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Fatal error in sync-manychat', { error: errorMessage });
    
    return new Response(JSON.stringify({
      ok: false,
      success: false,
      error: errorMessage
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
