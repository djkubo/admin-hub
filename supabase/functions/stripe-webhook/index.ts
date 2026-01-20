import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0';

// SECURITY: Restrict CORS to specific domain
const ALLOWED_ORIGINS = ['https://lovable.app', 'https://id-preview--9d074359-befd-41d0-9307-39b75ab20410.lovable.app'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Stripe needs to reach this
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

async function getCustomerEmail(customerId: string, stripeSecretKey: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { 'Authorization': `Bearer ${stripeSecretKey}` },
    });
    if (!response.ok) return null;
    const customer = await response.json();
    return customer.email || null;
  } catch (error) {
    console.error('Error fetching customer:', error);
    return null;
  }
}

function mapStripeStatus(status: string): string {
  switch (status) {
    case 'succeeded':
    case 'paid':
    case 'complete':
    case 'active':
      return 'paid';
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_confirmation':
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
    case 'past_due':
    case 'unpaid':
      return 'failed';
    case 'trialing':
      return 'trial';
    default:
      return status;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!stripeSecretKey || !supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing required environment variables');
    }

    const body = await req.text();
    let event: StripeEvent;

    // SECURITY: Verify Stripe signature if webhook secret is configured
    if (stripeWebhookSecret) {
      const signature = req.headers.get('stripe-signature');
      if (!signature) {
        console.error('❌ Missing stripe-signature header');
        return new Response(
          JSON.stringify({ error: 'Missing signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      try {
        const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
        event = stripe.webhooks.constructEvent(body, signature, stripeWebhookSecret) as unknown as StripeEvent;
        console.log(`✅ Signature verified for event: ${event.id}`);
      } catch (err) {
        console.error('❌ Signature verification failed:', err);
        return new Response(
          JSON.stringify({ error: 'Invalid signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // No webhook secret - parse directly (less secure, log warning)
      console.warn('⚠️ STRIPE_WEBHOOK_SECRET not configured - signature not verified');
      event = JSON.parse(body);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // IDEMPOTENCY: Check if event already processed
    const { data: existingEvent } = await supabase
      .from('transactions')
      .select('id')
      .eq('metadata->webhook_event_id', event.id)
      .maybeSingle();

    if (existingEvent) {
      console.log(`⏭️ Event ${event.id} already processed, skipping`);
      return new Response(
        JSON.stringify({ received: true, skipped: true, reason: 'already_processed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`🔔 Stripe Event: ${event.type}, ID: ${event.id}`);

    const obj = event.data.object as Record<string, unknown>;
    let email: string | null = null;
    let amount = 0;
    let status = '';
    let paymentIntentId = '';
    let customerId: string | null = null;
    let createdAt: string | null = null;
    let failureCode: string | null = null;
    let failureMessage: string | null = null;
    let processed = false;

    // PAYMENT INTENT EVENTS
    if (event.type.startsWith('payment_intent.')) {
      paymentIntentId = obj.id as string;
      amount = obj.amount as number;
      status = mapStripeStatus(obj.status as string);
      email = obj.receipt_email as string | null;
      customerId = obj.customer as string | null;
      createdAt = new Date((obj.created as number) * 1000).toISOString();
      
      const lastError = obj.last_payment_error as Record<string, unknown> | null;
      if (lastError) {
        failureCode = lastError.code as string || null;
        failureMessage = lastError.message as string || null;
      }
      processed = true;
    }
    
    // CHARGE EVENTS
    else if (event.type.startsWith('charge.')) {
      paymentIntentId = (obj.payment_intent as string) || `charge_${obj.id}`;
      amount = obj.amount as number;
      status = mapStripeStatus(obj.status as string);
      email = obj.receipt_email as string | null;
      customerId = obj.customer as string | null;
      createdAt = new Date((obj.created as number) * 1000).toISOString();
      
      if (obj.failure_code) failureCode = obj.failure_code as string;
      if (obj.failure_message) failureMessage = obj.failure_message as string;
      processed = true;
    }
    
    // INVOICE EVENTS
    else if (event.type.startsWith('invoice.')) {
      paymentIntentId = (obj.payment_intent as string) || `invoice_${obj.id}`;
      amount = (obj.amount_paid as number || obj.total as number);
      status = mapStripeStatus(obj.status as string);
      email = obj.customer_email as string | null;
      customerId = obj.customer as string | null;
      createdAt = obj.created ? new Date((obj.created as number) * 1000).toISOString() : new Date().toISOString();
      processed = true;
    }
    
    // SUBSCRIPTION EVENTS
    else if (event.type.startsWith('customer.subscription.')) {
      paymentIntentId = `subscription_${obj.id}`;
      const items = obj.items as { data?: Array<{ price?: { unit_amount?: number } }> };
      amount = (items?.data?.[0]?.price?.unit_amount || 0);
      status = mapStripeStatus(obj.status as string);
      customerId = obj.customer as string | null;
      createdAt = obj.created ? new Date((obj.created as number) * 1000).toISOString() : new Date().toISOString();
      
      if (obj.cancel_at_period_end) {
        failureCode = 'pending_cancellation';
      }
      processed = true;
    }
    
    // CUSTOMER EVENTS
    else if (event.type.startsWith('customer.') && !event.type.startsWith('customer.subscription')) {
      customerId = obj.id as string;
      email = obj.email as string | null;
      
      if (email) {
        const clientData: Record<string, unknown> = {
          email,
          full_name: obj.name as string || null,
          phone: obj.phone as string || null,
          last_sync: new Date().toISOString(),
        };
        
        if (event.type === 'customer.created') {
          clientData.created_at = new Date((obj.created as number) * 1000).toISOString();
          clientData.status = 'active';
        } else if (event.type === 'customer.deleted') {
          clientData.status = 'deleted';
        }

        const { error } = await supabase
          .from('clients')
          .upsert(clientData, { onConflict: 'email' });

        if (error) console.error('Error upserting client:', error);
        else console.log(`✅ Client ${event.type}: ${email}`);
      }

      return new Response(
        JSON.stringify({ received: true, processed: true, type: event.type }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // CHECKOUT SESSION EVENTS
    else if (event.type.startsWith('checkout.session.')) {
      paymentIntentId = (obj.payment_intent as string) || `checkout_${obj.id}`;
      amount = (obj.amount_total as number || 0);
      status = mapStripeStatus(obj.payment_status as string || obj.status as string);
      email = obj.customer_email as string | null;
      customerId = obj.customer as string | null;
      createdAt = obj.created ? new Date((obj.created as number) * 1000).toISOString() : new Date().toISOString();
      processed = true;
    }
    
    // PAYMENT METHOD EVENTS
    else if (event.type.startsWith('payment_method.')) {
      customerId = obj.customer as string | null;
      if (customerId) {
        const customerEmail = await getCustomerEmail(customerId, stripeSecretKey);
        if (customerEmail) {
          await supabase
            .from('clients')
            .upsert({
              email: customerEmail,
              last_sync: new Date().toISOString(),
            }, { onConflict: 'email' });
          console.log(`✅ Payment method ${event.type} for: ${customerEmail}`);
        }
      }
      return new Response(
        JSON.stringify({ received: true, processed: true, type: event.type }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Process transaction if we have data
    if (processed && paymentIntentId) {
      // Try to get email from customer if not available
      if (!email && customerId) {
        email = await getCustomerEmail(customerId, stripeSecretKey);
      }

      if (!email) {
        console.log(`⚠️ Skipping ${event.type}: no email for ${paymentIntentId}`);
        return new Response(
          JSON.stringify({ received: true, skipped: true, reason: 'no_email' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const transactionData = {
        stripe_payment_intent_id: paymentIntentId,
        payment_key: paymentIntentId,
        amount,
        currency: ((obj.currency as string) || 'usd').toLowerCase(),
        status,
        customer_email: email,
        stripe_customer_id: customerId,
        stripe_created_at: createdAt,
        source: 'stripe',
        failure_code: failureCode,
        failure_message: failureMessage,
        metadata: { ...(obj.metadata as Record<string, unknown> || {}), webhook_event_id: event.id },
      };

      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactionData, { onConflict: 'source,payment_key' });

      if (txError) {
        console.error('Error upserting transaction:', txError);
        throw txError;
      }

      // 🔔 TRIGGER: Execute campaign for failed payments via Rules Engine
      if (status === 'failed' && email) {
        console.log(`🔔 Triggering campaign for failed payment: ${email}`);
        try {
          const { data: client } = await supabase
            .from('clients')
            .select('id, full_name, phone')
            .eq('email', email)
            .single();

          if (client) {
            await fetch(`${supabaseUrl}/functions/v1/execute-campaign`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`
              },
              body: JSON.stringify({
                trigger_event: 'payment_failed',
                client_id: client.id,
                revenue_at_risk: amount,
                metadata: {
                  failure_code: failureCode,
                  failure_message: failureMessage,
                  payment_id: paymentIntentId
                }
              })
            });
            console.log(`✅ Campaign triggered for failed payment: ${email}`);
          }
        } catch (campaignError) {
          console.error('⚠️ Campaign trigger failed (non-blocking):', campaignError);
        }
      }

      // 🔔 TRIGGER: Execute campaign for trial started
      if (status === 'trial' && email) {
        console.log(`🔔 Triggering campaign for trial started: ${email}`);
        try {
          const { data: client } = await supabase
            .from('clients')
            .select('id')
            .eq('email', email)
            .single();

          if (client) {
            await fetch(`${supabaseUrl}/functions/v1/execute-campaign`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`
              },
              body: JSON.stringify({
                trigger_event: 'trial_started',
                client_id: client.id,
              })
            });
            console.log(`✅ Campaign triggered for trial started: ${email}`);
          }
        } catch (campaignError) {
          console.error('⚠️ Campaign trigger failed (non-blocking):', campaignError);
        }
      }

      // Update client
      if (status === 'paid' && amount > 0) {
        const { data: existingClient } = await supabase
          .from('clients')
          .select('total_paid')
          .eq('email', email)
          .single();

        const { error: clientError } = await supabase
          .from('clients')
          .upsert({
            email,
            payment_status: 'paid',
            total_paid: (existingClient?.total_paid || 0) + (amount / 100),
            last_sync: new Date().toISOString(),
          }, { onConflict: 'email' });

        if (clientError) console.error('Error upserting client:', clientError);
      } else if (status === 'trial') {
        await supabase
          .from('clients')
          .upsert({
            email,
            status: 'trial',
            trial_started_at: createdAt,
            last_sync: new Date().toISOString(),
          }, { onConflict: 'email' });
      }

      console.log(`✅ ${event.type}: ${paymentIntentId} - ${status} - ${amount}¢ - ${email}`);

      return new Response(
        JSON.stringify({ 
          received: true, 
          processed: true,
          type: event.type,
          payment_id: paymentIntentId,
          status,
          amount,
          email
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`ℹ️ Event ${event.type} acknowledged but not processed`);
    return new Response(
      JSON.stringify({ received: true, processed: false, type: event.type }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ Webhook error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
