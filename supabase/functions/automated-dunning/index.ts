import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Dunning schedule: Day 1, Day 3, Day 7
const DUNNING_SCHEDULE = [
  { days: 1, template: 'friendly', channel: 'whatsapp' },
  { days: 3, template: 'urgent', channel: 'sms' },
  { days: 7, template: 'final', channel: 'sms' },
];

const MAX_AUTO_ATTEMPTS = 3;

interface DunningResult {
  processed: number;
  messaged: number;
  recovered: number;
  marked_for_call: number;
  skipped: number;
  errors: string[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('🤖 Automated Dunning Started:', new Date().toISOString());

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const appUrl = Deno.env.get('APP_URL') || 'https://zen-admin-joy.lovable.app';

    if (!stripeKey) {
      return new Response(
        JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

    // ============= KILL SWITCH: Check if auto-dunning is enabled =============
    const { data: autoDunningConfig } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'auto_dunning_enabled')
      .single();

    const autoDunningEnabled = autoDunningConfig?.value !== 'false'; // Default: enabled
    
    if (!autoDunningEnabled) {
      console.log('⏸️ Auto-dunning disabled globally, skipping execution');
      return new Response(
        JSON.stringify({ 
          success: true, 
          status: 'skipped', 
          skipped: true, 
          reason: 'Feature disabled: auto_dunning_enabled is OFF' 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    // ===========================================================================

    // Parse optional dry_run parameter
    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = body.dry_run || false;
    } catch {
      // No body, use defaults
    }

    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

    const result: DunningResult = {
      processed: 0,
      messaged: 0,
      recovered: 0,
      marked_for_call: 0,
      skipped: 0,
      errors: [],
    };

    // Step 1: Fetch open/past_due invoices from the last 30 days
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    
    const invoices = await stripe.invoices.list({
      status: 'open',
      created: { gte: thirtyDaysAgo },
      limit: 100,
      expand: ['data.customer', 'data.subscription'],
    });

    console.log(`📋 Found ${invoices.data.length} open invoices in last 30 days`);

    for (const invoice of invoices.data) {
      result.processed++;
      
      const customer = invoice.customer as Stripe.Customer;
      const email = customer?.email;
      const phone = customer?.phone;
      const name = customer?.name || email?.split('@')[0] || 'Cliente';
      const amountDue = invoice.amount_due;
      const invoiceAge = Math.floor((Date.now() / 1000 - (invoice.created || 0)) / (24 * 60 * 60));

      console.log(`\n💳 Invoice ${invoice.id} | Age: ${invoiceAge}d | $${(amountDue / 100).toFixed(2)} | ${email || 'no email'}`);

      // Check if subscription is canceled
      if (invoice.subscription) {
        const sub = invoice.subscription as Stripe.Subscription;
        if (sub.status === 'canceled') {
          console.log(`⏭️ Skipping: Subscription canceled`);
          result.skipped++;
          continue;
        }
      }

      // Find client in CRM
      const { data: client } = await supabase
        .from('clients')
        .select('id, phone, phone_e164, full_name, stripe_customer_id')
        .or(`email.eq.${email},stripe_customer_id.eq.${customer?.id}`)
        .limit(1)
        .single();

      const clientPhone = client?.phone_e164 || client?.phone || phone;
      const clientName = client?.full_name || name;
      const clientId = client?.id;

      // Check last automated contact for this invoice (from messages table)
      const { data: lastMessage } = await supabase
        .from('messages')
        .select('created_at, metadata')
        .eq('direction', 'outbound')
        .or(`metadata->>invoice_id.eq.${invoice.id},to_address.ilike.%${clientPhone?.slice(-10)}`)
        .order('created_at', { ascending: false })
        .limit(1);

      // ALSO check client_events for manual dashboard contacts
      let lastManualContactDate: string | null = null;
      if (clientId) {
        const { data: lastEvent } = await supabase
          .from('client_events')
          .select('created_at, metadata')
          .eq('client_id', clientId)
          .eq('event_type', 'custom')
          .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()) // Last 48h
          .order('created_at', { ascending: false })
          .limit(1);
        
        // Check if this is a manual contact action
        const eventMetadata = lastEvent?.[0]?.metadata as Record<string, unknown> | null;
        if (eventMetadata?.source === 'dashboard_manual') {
          lastManualContactDate = lastEvent?.[0]?.created_at || null;
          console.log(`🔍 Found manual dashboard contact at ${lastManualContactDate}`);
        }
      }

      // Use the most recent contact (automated or manual)
      const lastAutoContactDate = lastMessage?.[0]?.created_at;
      const candidates = [lastAutoContactDate, lastManualContactDate].filter(Boolean).map(d => new Date(d!).getTime());
      const mostRecentContact = candidates.length > 0 ? Math.max(...candidates) : 0;
      const hoursSinceLastContact = mostRecentContact > 0 
        ? (Date.now() - mostRecentContact) / (1000 * 60 * 60)
        : Infinity;

      // Don't message if contacted in last 24h (automated OR manual)
      if (hoursSinceLastContact < 24) {
        console.log(`⏭️ Skipping: Already contacted ${hoursSinceLastContact.toFixed(1)}h ago (${lastManualContactDate ? 'manual' : 'auto'})`);
        result.skipped++;
        continue;
      }

      // Determine which dunning step based on invoice age
      const dunningStep = DUNNING_SCHEDULE.find(step => invoiceAge >= step.days);
      
      if (!dunningStep) {
        console.log(`⏭️ Skipping: Invoice too new (${invoiceAge} days)`);
        result.skipped++;
        continue;
      }

      // Check attempt count
      const { count: attemptCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('direction', 'outbound')
        .or(`metadata->>invoice_id.eq.${invoice.id},to_address.ilike.%${clientPhone?.slice(-10)}`)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

      if ((attemptCount || 0) >= MAX_AUTO_ATTEMPTS) {
        console.log(`⚠️ Max attempts (${attemptCount}) reached - marking for manual call`);
        
        // Log event for manual followup
        if (clientId) {
          await supabase.from('client_events').insert({
            client_id: clientId,
            event_type: 'custom',
            metadata: {
              action: 'marked_for_manual_call',
              invoice_id: invoice.id,
              amount_due: amountDue,
              attempts: attemptCount,
              timestamp: new Date().toISOString(),
            },
          });
        }
        
        result.marked_for_call++;
        continue;
      }

      if (!clientPhone) {
        console.log(`⏭️ Skipping: No phone number`);
        result.skipped++;
        continue;
      }

      // Generate portal link for card update
      let portalUrl = appUrl;
      
      try {
        const linkResponse = await fetch(`${supabaseUrl}/functions/v1/generate-payment-link`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            stripe_customer_id: customer?.id,
            invoice_id: invoice.id,
            client_id: clientId,
            customer_email: email,
            customer_name: clientName,
          }),
        });
        
        const linkData = await linkResponse.json();
        if (linkData.url) {
          portalUrl = linkData.url;
          console.log(`🔗 Generated portal link: ${portalUrl}`);
        }
      } catch (linkError) {
        console.warn('Could not generate portal link:', linkError);
      }

      // Build message with portal link
      const messageTemplates = {
        friendly: `Hola ${clientName} 👋 Notamos que tu pago de $${(amountDue / 100).toFixed(2)} no se procesó. Actualiza tu tarjeta aquí para no perder acceso: ${portalUrl}`,
        urgent: `⚠️ ${clientName}, tu cuenta tiene un pago pendiente de $${(amountDue / 100).toFixed(2)}. Actualiza tu método de pago hoy: ${portalUrl}`,
        final: `🚨 ÚLTIMO AVISO: ${clientName}, tu servicio será suspendido en 24h. Actualiza tu tarjeta ahora: ${portalUrl}`,
      };

      const message = messageTemplates[dunningStep.template as keyof typeof messageTemplates];

      console.log(`📤 Sending ${dunningStep.template} via ${dunningStep.channel} to ${clientPhone}`);

      if (dryRun) {
        console.log(`[DRY RUN] Would send: "${message.slice(0, 50)}..."`);
        result.messaged++;
        continue;
      }

      // Send the message
      try {
        const smsResponse = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            to: clientPhone,
            message,
            channel: dunningStep.channel,
            client_id: clientId,
          }),
        });

        const smsResult = await smsResponse.json();
        
        if (smsResult.success || smsResult.message_sid) {
          console.log(`✅ Message sent: ${smsResult.message_sid}`);
          result.messaged++;

          // Update message metadata with invoice_id for tracking
          await supabase
            .from('messages')
            .update({
              metadata: {
                invoice_id: invoice.id,
                template: dunningStep.template,
                dunning_day: dunningStep.days,
                automated: true,
              },
            })
            .eq('external_message_id', smsResult.message_sid);

          // Log client event
          if (clientId) {
            await supabase.from('client_events').insert({
              client_id: clientId,
              event_type: 'email_sent',
              metadata: {
                action: 'automated_dunning',
                channel: dunningStep.channel,
                template: dunningStep.template,
                invoice_id: invoice.id,
                amount_due: amountDue,
                portal_link: portalUrl,
              },
            });
          }
        } else {
          console.error(`❌ Failed to send:`, smsResult.error || smsResult);
          result.errors.push(`${invoice.id}: ${smsResult.error || 'Unknown error'}`);
        }
      } catch (sendError) {
        console.error(`❌ Error sending message:`, sendError);
        result.errors.push(`${invoice.id}: ${sendError instanceof Error ? sendError.message : 'Send failed'}`);
      }

      // Rate limit: 100ms between messages
      await new Promise(r => setTimeout(r, 100));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n📊 Dunning Complete in ${duration}s:`);
    console.log(`   Processed: ${result.processed}`);
    console.log(`   Messaged: ${result.messaged}`);
    console.log(`   Marked for Call: ${result.marked_for_call}`);
    console.log(`   Skipped: ${result.skipped}`);
    console.log(`   Errors: ${result.errors.length}`);

    // Log the run
    await supabase.from('sync_runs').insert({
      source: 'automated_dunning',
      status: 'completed',
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      metadata: {
        dry_run: dryRun,
        ...result,
      },
      total_fetched: result.processed,
      total_inserted: result.messaged,
      total_skipped: result.skipped,
    });

    return new Response(
      JSON.stringify({
        success: true,
        duration_seconds: parseFloat(duration),
        ...result,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Dunning error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
