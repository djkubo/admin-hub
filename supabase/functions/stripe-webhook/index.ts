import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  
  if (!webhookSecret || !stripeKey) {
    console.error('❌ stripe-webhook: Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY');
    return new Response(
      JSON.stringify({ error: 'Webhook not configured' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
  const signature = req.headers.get('stripe-signature');
  
  if (!signature) {
    console.error('❌ stripe-webhook: Missing stripe-signature header');
    return new Response(
      JSON.stringify({ error: 'Missing signature' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('❌ stripe-webhook: Signature verification failed:', message);
    return new Response(
      JSON.stringify({ error: 'Invalid signature' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log(`✅ stripe-webhook: Verified event ${event.type} (${event.id})`);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Idempotency check
  const { data: existing } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('event_id', event.id)
    .single();

  if (existing) {
    console.log(`⚠️ stripe-webhook: Event ${event.id} already processed, skipping`);
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Log event for idempotency
  await supabase.from('webhook_events').insert({
    event_id: event.id,
    event_type: event.type,
    source: 'stripe',
    payload: event.data.object
  });

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        await handlePaymentSucceeded(supabase, stripe, pi);
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        await handlePaymentFailed(supabase, pi);
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(supabase, invoice);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(supabase, invoice);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdate(supabase, stripe, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(supabase, sub);
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        await handleRefund(supabase, charge);
        break;
      }
      default:
        console.log(`ℹ️ stripe-webhook: Unhandled event type ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error(`❌ stripe-webhook: Error processing ${event.type}:`, err);
    return new Response(JSON.stringify({ error: 'Processing error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function handlePaymentSucceeded(supabase: any, stripe: Stripe, pi: Stripe.PaymentIntent) {
  console.log(`💰 Processing payment_intent.succeeded: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  
  // Get customer email
  let customerEmail = null;
  if (pi.customer) {
    try {
      const customer = await stripe.customers.retrieve(String(pi.customer));
      if (customer && !customer.deleted) {
        customerEmail = customer.email;
      }
    } catch (e) {
      console.warn('Could not fetch customer:', e);
    }
  }

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: pi.id,
    payment_key: paymentKey,
    amount: pi.amount / 100,
    currency: pi.currency?.toUpperCase() || 'USD',
    status: 'succeeded',
    stripe_customer_id: pi.customer ? String(pi.customer) : null,
    customer_email: customerEmail,
    source: 'stripe',
    stripe_created_at: new Date(pi.created * 1000).toISOString(),
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting transaction:', error);
  else console.log(`✅ Transaction upserted: ${pi.id}`);
}

async function handlePaymentFailed(supabase: any, pi: Stripe.PaymentIntent) {
  console.log(`❌ Processing payment_intent.payment_failed: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  const lastError = pi.last_payment_error;

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: pi.id,
    payment_key: paymentKey,
    amount: pi.amount / 100,
    currency: pi.currency?.toUpperCase() || 'USD',
    status: 'failed',
    stripe_customer_id: pi.customer ? String(pi.customer) : null,
    source: 'stripe',
    failure_code: lastError?.code || null,
    failure_message: lastError?.message || null,
    stripe_created_at: new Date(pi.created * 1000).toISOString(),
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting failed transaction:', error);
}

async function handleInvoicePaid(supabase: any, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice.paid: ${invoice.id}`);
  
  // Remove from pending invoices
  const { error } = await supabase
    .from('invoices')
    .delete()
    .eq('stripe_invoice_id', invoice.id);

  if (error) console.error('Error removing paid invoice:', error);
  else console.log(`✅ Removed paid invoice: ${invoice.id}`);
}

async function handleInvoicePaymentFailed(supabase: any, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice.payment_failed: ${invoice.id}`);
  
  const { error } = await supabase.from('invoices').upsert({
    stripe_invoice_id: invoice.id,
    stripe_customer_id: invoice.customer ? String(invoice.customer) : null,
    customer_email: invoice.customer_email,
    amount_due: (invoice.amount_due || 0) / 100,
    currency: invoice.currency?.toUpperCase() || 'USD',
    status: 'open',
    hosted_invoice_url: invoice.hosted_invoice_url,
    next_payment_attempt: invoice.next_payment_attempt 
      ? new Date(invoice.next_payment_attempt * 1000).toISOString() 
      : null,
    period_end: invoice.period_end 
      ? new Date(invoice.period_end * 1000).toISOString() 
      : null,
  }, { onConflict: 'stripe_invoice_id' });

  if (error) console.error('Error upserting failed invoice:', error);
}

async function handleSubscriptionUpdate(supabase: any, stripe: Stripe, sub: Stripe.Subscription) {
  console.log(`📦 Processing subscription update: ${sub.id} (${sub.status})`);
  
  let planName = 'Unknown Plan';
  let planId = null;
  let amount = 0;
  let interval = null;
  let customerEmail = null;

  // Get plan details
  if (sub.items?.data?.[0]?.price) {
    const price = sub.items.data[0].price;
    planId = price.id;
    amount = (price.unit_amount || 0) / 100;
    interval = price.recurring?.interval || null;
    
    if (price.product) {
      try {
        const product = await stripe.products.retrieve(String(price.product));
        planName = product.name || price.nickname || 'Unknown Plan';
      } catch (e) {
        planName = price.nickname || 'Unknown Plan';
      }
    }
  }

  // Get customer email
  if (sub.customer) {
    try {
      const customer = await stripe.customers.retrieve(String(sub.customer));
      if (customer && !customer.deleted) {
        customerEmail = customer.email;
      }
    } catch (e) {
      console.warn('Could not fetch customer:', e);
    }
  }

  const { error } = await supabase.from('subscriptions').upsert({
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer ? String(sub.customer) : null,
    customer_email: customerEmail,
    status: sub.status,
    plan_name: planName,
    plan_id: planId,
    amount: amount,
    currency: sub.currency?.toUpperCase() || 'USD',
    interval: interval,
    current_period_start: sub.current_period_start 
      ? new Date(sub.current_period_start * 1000).toISOString() 
      : null,
    current_period_end: sub.current_period_end 
      ? new Date(sub.current_period_end * 1000).toISOString() 
      : null,
    trial_start: sub.trial_start 
      ? new Date(sub.trial_start * 1000).toISOString() 
      : null,
    trial_end: sub.trial_end 
      ? new Date(sub.trial_end * 1000).toISOString() 
      : null,
    canceled_at: sub.canceled_at 
      ? new Date(sub.canceled_at * 1000).toISOString() 
      : null,
    cancel_reason: sub.cancellation_details?.reason || null,
    provider: 'stripe',
  }, { onConflict: 'stripe_subscription_id' });

  if (error) console.error('Error upserting subscription:', error);
  else console.log(`✅ Subscription upserted: ${sub.id}`);
}

async function handleSubscriptionDeleted(supabase: any, sub: Stripe.Subscription) {
  console.log(`🗑️ Processing subscription.deleted: ${sub.id}`);
  
  const { error } = await supabase
    .from('subscriptions')
    .update({ 
      status: 'canceled',
      canceled_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', sub.id);

  if (error) console.error('Error updating deleted subscription:', error);
  else console.log(`✅ Subscription marked as canceled: ${sub.id}`);
}

async function handleRefund(supabase: any, charge: Stripe.Charge) {
  console.log(`💸 Processing charge.refunded: ${charge.id}`);
  
  const piId = charge.payment_intent ? String(charge.payment_intent) : null;
  if (!piId) {
    console.warn('Refund charge has no payment_intent, skipping');
    return;
  }

  const { error } = await supabase
    .from('transactions')
    .update({ status: 'refunded' })
    .eq('stripe_payment_intent_id', piId);

  if (error) console.error('Error updating refunded transaction:', error);
  else console.log(`✅ Transaction marked as refunded: ${piId}`);
}
