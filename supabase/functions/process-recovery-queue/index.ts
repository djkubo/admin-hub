import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@14.21.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface RecoveryQueueItem {
  id: string;
  invoice_id: string;
  client_id: string | null;
  stripe_customer_id: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  amount_due: number;
  currency: string;
  failure_reason: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  portal_link_token: string | null;
  retry_at: string;
}

// Retry delays in hours: [48h, +72h (3 days), +120h (5 days)]
const RETRY_DELAYS_HOURS = [48, 72, 120];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');

    if (!stripeKey) {
      return new Response(
        JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

    // Parse optional parameters
    let batchSize = 10;
    let dryRun = false;
    
    try {
      const body = await req.json();
      batchSize = body.batch_size || 10;
      dryRun = body.dry_run || false;
    } catch {
      // No body provided, use defaults
    }

    console.log(`🔄 Processing recovery queue (batch: ${batchSize}, dry_run: ${dryRun})`);

    // Get items ready for processing
    const now = new Date().toISOString();
    const { data: queueItems, error: fetchError } = await supabase
      .from('recovery_queue')
      .select('*')
      .in('status', ['pending', 'notified'])
      .lte('retry_at', now)
      .order('retry_at', { ascending: true })
      .limit(batchSize);

    if (fetchError) {
      console.error('❌ Error fetching queue:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch queue', details: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!queueItems || queueItems.length === 0) {
      console.log('ℹ️ No items ready for processing');
      return new Response(
        JSON.stringify({ success: true, message: 'No items to process', processed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📋 Found ${queueItems.length} items to process`);

    const results = {
      processed: 0,
      recovered: 0,
      failed: 0,
      rescheduled: 0,
      recovered_amount: 0,
      errors: [] as string[],
    };

    for (const item of queueItems as RecoveryQueueItem[]) {
      console.log(`\n💳 Processing invoice: ${item.invoice_id}`);

      try {
        // Mark as retrying
        await supabase
          .from('recovery_queue')
          .update({ status: 'retrying', last_attempt_at: now })
          .eq('id', item.id);

        // Fetch the invoice from Stripe
        const invoice = await stripe.invoices.retrieve(item.invoice_id);
        
        // Check if already paid
        if (invoice.status === 'paid') {
          console.log(`✅ Invoice ${item.invoice_id} already paid!`);
          await supabase
            .from('recovery_queue')
            .update({
              status: 'recovered',
              recovered_at: now,
              recovered_amount: invoice.amount_paid,
            })
            .eq('id', item.id);
          results.recovered++;
          results.recovered_amount += invoice.amount_paid || 0;
          continue;
        }

        // Check if subscription is canceled
        if (invoice.subscription) {
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subId);
          
          if (subscription.status === 'canceled') {
            console.log(`⚠️ Subscription ${subId} is canceled, marking as failed`);
            await supabase
              .from('recovery_queue')
              .update({
                status: 'cancelled',
                last_error: 'Subscription is canceled',
              })
              .eq('id', item.id);
            results.failed++;
            continue;
          }
        }

        if (dryRun) {
          console.log(`🔍 [DRY RUN] Would attempt to pay invoice ${item.invoice_id}`);
          results.processed++;
          continue;
        }

        // Attempt to pay the invoice
        let paymentSucceeded = false;
        let lastError = '';

        try {
          // Try to pay with default payment method
          const paidInvoice = await stripe.invoices.pay(item.invoice_id);
          
          if (paidInvoice.status === 'paid') {
            paymentSucceeded = true;
            console.log(`✅ Payment succeeded for ${item.invoice_id}!`);
          }
        } catch (payError: unknown) {
          const errorMessage = payError instanceof Error ? payError.message : 'Unknown payment error';
          lastError = errorMessage;
          console.log(`❌ Payment attempt failed: ${errorMessage}`);

          // Try alternate payment methods
          const paymentMethods = await stripe.paymentMethods.list({
            customer: item.stripe_customer_id,
            type: 'card',
            limit: 3,
          });

          for (const pm of paymentMethods.data) {
            if (paymentSucceeded) break;

            try {
              console.log(`🔄 Trying alternate card: ${pm.id}`);
              
              // Update default payment method and retry
              await stripe.customers.update(item.stripe_customer_id, {
                invoice_settings: { default_payment_method: pm.id },
              });

              await new Promise(resolve => setTimeout(resolve, 200)); // Rate limit

              const retryInvoice = await stripe.invoices.pay(item.invoice_id);
              
              if (retryInvoice.status === 'paid') {
                paymentSucceeded = true;
                console.log(`✅ Payment succeeded with alternate card!`);
              }
            } catch (altError: unknown) {
              const altMessage = altError instanceof Error ? altError.message : 'Unknown error';
              lastError = altMessage;
              console.log(`❌ Alternate card failed: ${altMessage}`);
            }
          }
        }

        if (paymentSucceeded) {
          await supabase
            .from('recovery_queue')
            .update({
              status: 'recovered',
              recovered_at: now,
              recovered_amount: item.amount_due,
            })
            .eq('id', item.id);
          
          results.recovered++;
          results.recovered_amount += item.amount_due;

          // Send success notification
          if (item.customer_phone) {
            try {
              await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${supabaseServiceKey}`,
                },
                body: JSON.stringify({
                  to: item.customer_phone,
                  message: `✅ ${item.customer_name || 'Hola'}, tu pago de $${(item.amount_due / 100).toFixed(2)} se procesó exitosamente. ¡Gracias!`,
                  client_id: item.client_id,
                }),
              });
            } catch (notifyError) {
              console.warn('Could not send success notification:', notifyError);
            }
          }
        } else {
          // Payment failed
          const newAttemptCount = item.attempt_count + 1;

          if (newAttemptCount >= item.max_attempts) {
            // Max attempts reached - mark as failed
            console.log(`❌ Max attempts reached for ${item.invoice_id}`);
            
            await supabase
              .from('recovery_queue')
              .update({
                status: 'failed',
                attempt_count: newAttemptCount,
                last_error: lastError,
              })
              .eq('id', item.id);
            
            results.failed++;

            // Send final notice
            if (item.customer_phone) {
              try {
                await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({
                    to: item.customer_phone,
                    template: 'final',
                    client_name: item.customer_name,
                    amount: item.amount_due,
                    client_id: item.client_id,
                  }),
                });
              } catch (notifyError) {
                console.warn('Could not send final notice:', notifyError);
              }
            }
          } else {
            // Schedule next retry
            const delayHours = RETRY_DELAYS_HOURS[Math.min(newAttemptCount, RETRY_DELAYS_HOURS.length - 1)];
            const nextRetry = new Date();
            nextRetry.setHours(nextRetry.getHours() + delayHours);

            console.log(`⏰ Scheduling retry #${newAttemptCount + 1} for ${nextRetry.toISOString()}`);

            await supabase
              .from('recovery_queue')
              .update({
                status: 'notified',
                attempt_count: newAttemptCount,
                retry_at: nextRetry.toISOString(),
                last_error: lastError,
              })
              .eq('id', item.id);

            results.rescheduled++;

            // Send reminder notification
            if (item.customer_phone) {
              try {
                await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({
                    to: item.customer_phone,
                    template: 'urgent',
                    client_name: item.customer_name,
                    amount: item.amount_due,
                    client_id: item.client_id,
                  }),
                });
              } catch (notifyError) {
                console.warn('Could not send reminder:', notifyError);
              }
            }
          }
        }

        results.processed++;

      } catch (itemError: unknown) {
        const errorMessage = itemError instanceof Error ? itemError.message : 'Unknown error';
        console.error(`❌ Error processing ${item.invoice_id}:`, errorMessage);
        results.errors.push(`${item.invoice_id}: ${errorMessage}`);
        
        await supabase
          .from('recovery_queue')
          .update({
            status: 'notified',
            last_error: errorMessage,
          })
          .eq('id', item.id);
      }
    }

    console.log('\n📊 Recovery Queue Processing Complete:');
    console.log(`   Processed: ${results.processed}`);
    console.log(`   Recovered: ${results.recovered} ($${(results.recovered_amount / 100).toFixed(2)})`);
    console.log(`   Rescheduled: ${results.rescheduled}`);
    console.log(`   Failed: ${results.failed}`);

    return new Response(
      JSON.stringify({
        success: true,
        ...results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error in process-recovery-queue:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
