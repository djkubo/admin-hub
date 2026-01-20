import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncRequest {
  dry_run?: boolean;
  batch_size?: number;
  checkpoint?: { page?: number };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const manychatApiKey = Deno.env.get('MANYCHAT_API_KEY');

    if (!manychatApiKey) {
      return new Response(
        JSON.stringify({ error: 'MANYCHAT_API_KEY required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: SyncRequest = await req.json().catch(() => ({}));
    const dryRun = body.dry_run ?? false;
    const batchSize = body.batch_size ?? 100;
    let page = body.checkpoint?.page ?? 1;

    console.log(`[sync-manychat] Starting sync, dry_run=${dryRun}, batch_size=${batchSize}`);

    // Create sync run
    const { data: syncRun, error: syncError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'manychat',
        status: 'running',
        dry_run: dryRun,
        checkpoint: { page }
      })
      .select()
      .single();

    if (syncError) {
      console.error('[sync-manychat] Failed to create sync run:', syncError);
      throw syncError;
    }

    const syncRunId = syncRun.id;
    let totalFetched = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalConflicts = 0;
    let hasMore = true;
    const maxPages = 50;

    while (hasMore && page <= maxPages) {
      console.log(`[sync-manychat] Fetching page ${page}`);

      // Fetch subscribers from ManyChat
      const mcResponse = await fetch(
        `https://api.manychat.com/fb/subscriber/getSubscribers?page=${page}&limit=${batchSize}`,
        {
          headers: {
            'Authorization': `Bearer ${manychatApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!mcResponse.ok) {
        const errorText = await mcResponse.text();
        console.error(`[sync-manychat] API error: ${mcResponse.status} ${errorText}`);
        throw new Error(`ManyChat API error: ${mcResponse.status}`);
      }

      const mcData = await mcResponse.json();
      
      if (mcData.status !== 'success') {
        throw new Error(`ManyChat API returned error: ${mcData.message || 'Unknown'}`);
      }

      const subscribers = mcData.data || [];
      console.log(`[sync-manychat] Fetched ${subscribers.length} subscribers`);
      totalFetched += subscribers.length;

      // Process each subscriber
      for (const sub of subscribers) {
        try {
          // Store raw data for audit
          if (!dryRun) {
            await supabase
              .from('manychat_contacts_raw')
              .insert({
                subscriber_id: sub.id,
                payload: sub,
                sync_run_id: syncRunId
              })
              .select();
          }

          // Extract fields with ManyChat field mapping
          const email = sub.email || null;
          const phone = sub.phone || sub.whatsapp_phone || null;
          const fullName = [sub.first_name, sub.last_name].filter(Boolean).join(' ') || sub.name || null;
          const tags = (sub.tags || []).map((t: any) => t.name || t);
          const waOptIn = sub.optin_whatsapp === true;
          const smsOptIn = sub.optin_sms === true;
          const emailOptIn = sub.optin_email !== false;

          // Call merge function
          const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_contact', {
            p_source: 'manychat',
            p_external_id: sub.id,
            p_email: email,
            p_phone: phone,
            p_full_name: fullName,
            p_tags: tags,
            p_wa_opt_in: waOptIn,
            p_sms_opt_in: smsOptIn,
            p_email_opt_in: emailOptIn,
            p_extra_data: sub,
            p_dry_run: dryRun,
            p_sync_run_id: syncRunId
          });

          if (mergeError) {
            console.error(`[sync-manychat] Merge error for ${sub.id}:`, mergeError);
            totalSkipped++;
            continue;
          }

          const action = mergeResult?.action || 'none';
          if (action === 'inserted') totalInserted++;
          else if (action === 'updated') totalUpdated++;
          else if (action === 'conflict') totalConflicts++;
          else totalSkipped++;

        } catch (subError) {
          console.error(`[sync-manychat] Error processing subscriber ${sub.id}:`, subError);
          totalSkipped++;
        }
      }

      // Check pagination
      if (subscribers.length < batchSize) {
        hasMore = false;
      } else {
        page++;
        // Update checkpoint
        await supabase
          .from('sync_runs')
          .update({
            checkpoint: { page },
            total_fetched: totalFetched,
            total_inserted: totalInserted,
            total_updated: totalUpdated,
            total_skipped: totalSkipped,
            total_conflicts: totalConflicts
          })
          .eq('id', syncRunId);
      }
    }

    // Mark sync as complete
    await supabase
      .from('sync_runs')
      .update({
        status: hasMore ? 'partial' : 'completed',
        completed_at: new Date().toISOString(),
        total_fetched: totalFetched,
        total_inserted: totalInserted,
        total_updated: totalUpdated,
        total_skipped: totalSkipped,
        total_conflicts: totalConflicts,
        checkpoint: { page }
      })
      .eq('id', syncRunId);

    console.log(`[sync-manychat] Completed: ${totalFetched} fetched, ${totalInserted} inserted, ${totalUpdated} updated, ${totalConflicts} conflicts`);

    return new Response(
      JSON.stringify({
        success: true,
        sync_run_id: syncRunId,
        dry_run: dryRun,
        stats: {
          total_fetched: totalFetched,
          total_inserted: totalInserted,
          total_updated: totalUpdated,
          total_skipped: totalSkipped,
          total_conflicts: totalConflicts,
          has_more: hasMore,
          next_page: page
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[sync-manychat] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
