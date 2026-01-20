import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
};

// SECURITY: Simple admin key guard
function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  if (!adminKey) {
    return { valid: false, error: "ADMIN_API_KEY not configured" };
  }
  const providedKey = req.headers.get("x-admin-key");
  if (!providedKey || providedKey !== adminKey) {
    return { valid: false, error: "Invalid or missing x-admin-key" };
  }
  return { valid: true };
}

interface SyncRequest {
  dry_run?: boolean;
  batch_size?: number;
  checkpoint?: { cursor?: string };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify x-admin-key
    const authCheck = verifyAdminKey(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log("✅ Admin key verified");

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ghlApiKey = Deno.env.get('GHL_API_KEY');
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID');

    if (!ghlApiKey || !ghlLocationId) {
      return new Response(
        JSON.stringify({ error: 'GHL_API_KEY and GHL_LOCATION_ID required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const body: SyncRequest = await req.json().catch(() => ({}));
    const dryRun = body.dry_run ?? false;
    const batchSize = body.batch_size ?? 100;
    let cursor = body.checkpoint?.cursor;

    console.log(`[sync-ghl] Starting sync, dry_run=${dryRun}, batch_size=${batchSize}`);

    // Create sync run
    const { data: syncRun, error: syncError } = await supabase
      .from('sync_runs')
      .insert({
        source: 'ghl',
        status: 'running',
        dry_run: dryRun,
        checkpoint: { cursor }
      })
      .select()
      .single();

    if (syncError) {
      console.error('[sync-ghl] Failed to create sync run:', syncError);
      throw syncError;
    }

    const syncRunId = syncRun.id;
    let totalFetched = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalConflicts = 0;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 50;

    while (hasMore && pageCount < maxPages) {
      pageCount++;
      console.log(`[sync-ghl] Fetching page ${pageCount}, cursor=${cursor || 'initial'}`);

      const ghlUrl = new URL(`https://services.leadconnectorhq.com/contacts/`);
      ghlUrl.searchParams.set('locationId', ghlLocationId);
      ghlUrl.searchParams.set('limit', batchSize.toString());
      if (cursor) {
        ghlUrl.searchParams.set('startAfterId', cursor);
      }

      console.log(`[sync-ghl] Calling GHL API: ${ghlUrl.toString()}`);

      const ghlResponse = await fetch(ghlUrl.toString(), {
        headers: {
          'Authorization': `Bearer ${ghlApiKey}`,
          'Version': '2021-07-28',
          'Accept': 'application/json'
        }
      });

      if (!ghlResponse.ok) {
        const errorText = await ghlResponse.text();
        console.error(`[sync-ghl] GHL API error: ${ghlResponse.status}`);
        console.error(`[sync-ghl] Error response: ${errorText}`);
        throw new Error(`GHL API error: ${ghlResponse.status} - ${errorText}`);
      }

      const ghlData = await ghlResponse.json();
      const contacts = ghlData.contacts || [];
      
      console.log(`[sync-ghl] Fetched ${contacts.length} contacts`);
      totalFetched += contacts.length;

      for (const contact of contacts) {
        try {
          if (!dryRun) {
            await supabase
              .from('ghl_contacts_raw')
              .insert({
                external_id: contact.id,
                payload: contact,
                sync_run_id: syncRunId
              })
              .select();
          }

          const email = contact.email || null;
          const phone = contact.phone || contact.phoneNumber || null;
          const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name || null;
          const tags = contact.tags || [];
          const waOptIn = contact.dndSettings?.whatsApp?.status !== 'active';
          const smsOptIn = contact.dndSettings?.sms?.status !== 'active';
          const emailOptIn = contact.dndSettings?.email?.status !== 'active';

          const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_contact', {
            p_source: 'ghl',
            p_external_id: contact.id,
            p_email: email,
            p_phone: phone,
            p_full_name: fullName,
            p_tags: tags,
            p_wa_opt_in: waOptIn,
            p_sms_opt_in: smsOptIn,
            p_email_opt_in: emailOptIn,
            p_extra_data: contact,
            p_dry_run: dryRun,
            p_sync_run_id: syncRunId
          });

          if (mergeError) {
            console.error(`[sync-ghl] Merge error for ${contact.id}:`, mergeError);
            totalSkipped++;
            continue;
          }

          const action = mergeResult?.action || 'none';
          if (action === 'inserted') totalInserted++;
          else if (action === 'updated') totalUpdated++;
          else if (action === 'conflict') totalConflicts++;
          else totalSkipped++;

        } catch (contactError) {
          console.error(`[sync-ghl] Error processing contact ${contact.id}:`, contactError);
          totalSkipped++;
        }
      }

      if (contacts.length < batchSize) {
        hasMore = false;
      } else {
        cursor = contacts[contacts.length - 1]?.id;
        await supabase
          .from('sync_runs')
          .update({
            checkpoint: { cursor },
            total_fetched: totalFetched,
            total_inserted: totalInserted,
            total_updated: totalUpdated,
            total_skipped: totalSkipped,
            total_conflicts: totalConflicts
          })
          .eq('id', syncRunId);
      }
    }

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
        checkpoint: { cursor }
      })
      .eq('id', syncRunId);

    console.log(`[sync-ghl] Completed: ${totalFetched} fetched, ${totalInserted} inserted, ${totalUpdated} updated, ${totalConflicts} conflicts`);

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
          next_cursor: cursor
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('[sync-ghl] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
