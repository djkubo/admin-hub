import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, paypal-transmission-id, paypal-transmission-time, paypal-transmission-sig, paypal-cert-url, paypal-auth-algo',
};

async function getPayPalAccessToken(clientId: string, secret: string): Promise<string> {
  const response = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${clientId}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  
  if (!response.ok) {
    throw new Error(`PayPal auth failed: ${response.status}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

async function verifyWebhookSignature(
  accessToken: string,
  webhookId: string,
  headers: Headers,
  body: string
): Promise<boolean> {
  const transmissionId = headers.get('paypal-transmission-id');
  const transmissionTime = headers.get('paypal-transmission-time');
  const transmissionSig = headers.get('paypal-transmission-sig');
  const certUrl = headers.get('paypal-cert-url');
  const authAlgo = headers.get('paypal-auth-algo');

  console.log(`🔍 PayPal headers: id=${transmissionId ? 'present' : 'MISSING'}, time=${transmissionTime ? 'present' : 'MISSING'}, sig=${transmissionSig ? 'present' : 'MISSING'}, cert=${certUrl ? 'present' : 'MISSING'}, algo=${authAlgo ? 'present' : 'MISSING'}`);
  console.log(`🔍 Webhook ID being used: ${webhookId}`);

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    console.error('❌ Missing PayPal signature headers');
    return false;
  }

  const verifyPayload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: JSON.parse(body),
  };

  console.log(`📤 Calling PayPal verify-webhook-signature API...`);

  const response = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(verifyPayload),
  });

  const responseText = await response.text();
  console.log(`📥 PayPal verify response: status=${response.status}, body=${responseText}`);

  if (!response.ok) {
    console.error(`❌ PayPal verification request failed: ${response.status} - ${responseText}`);
    return false;
  }

  const result = JSON.parse(responseText);
  console.log(`🔐 Verification result: ${result.verification_status}`);
  return result.verification_status === 'SUCCESS';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientId = Deno.env.get('PAYPAL_CLIENT_ID');
  const secret = Deno.env.get('PAYPAL_SECRET');
  const webhookId = Deno.env.get('PAYPAL_WEBHOOK_ID');

  if (!clientId || !secret || !webhookId) {
    console.error('❌ paypal-webhook: Missing PAYPAL_CLIENT_ID, PAYPAL_SECRET, or PAYPAL_WEBHOOK_ID');
    return new Response(
      JSON.stringify({ error: 'Webhook not configured' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const body = await req.text();
  
  try {
    // Get access token and verify signature
    const accessToken = await getPayPalAccessToken(clientId, secret);
    const isValid = await verifyWebhookSignature(accessToken, webhookId, req.headers, body);

    if (!isValid) {
      console.error('❌ paypal-webhook: Signature verification failed');
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const event = JSON.parse(body);
    console.log(`✅ paypal-webhook: Verified event ${event.event_type} (${event.id})`);

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
      console.log(`⚠️ paypal-webhook: Event ${event.id} already processed, skipping`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Log event for idempotency
    await supabase.from('webhook_events').insert({
      event_id: event.id,
      event_type: event.event_type,
      source: 'paypal',
      payload: event.resource
    });

    // Process event
    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCompleted(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.DENIED':
        await handlePaymentDenied(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentRefunded(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.CREATED':
      case 'BILLING.SUBSCRIPTION.UPDATED':
        await handleSubscriptionUpdate(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
        await handleSubscriptionCancelled(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await handleSubscriptionPaymentFailed(supabase, event.resource);
        break;
      default:
        console.log(`ℹ️ paypal-webhook: Unhandled event type ${event.event_type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('❌ paypal-webhook: Error:', message);
    return new Response(
      JSON.stringify({ error: 'Processing error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function handlePaymentCompleted(supabase: any, resource: any) {
  console.log(`💰 Processing PAYMENT.CAPTURE.COMPLETED: ${resource.id}`);
  
  const amount = parseFloat(resource.amount?.value || '0');
  const currency = resource.amount?.currency_code || 'USD';

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: `paypal_${resource.id}`,
    payment_key: `paypal_${resource.id}`,
    amount: amount,
    currency: currency,
    status: 'succeeded',
    source: 'paypal',
    stripe_created_at: resource.create_time || new Date().toISOString(),
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting PayPal transaction:', error);
  else console.log(`✅ PayPal transaction upserted: ${resource.id}`);
}

async function handlePaymentDenied(supabase: any, resource: any) {
  console.log(`❌ Processing PAYMENT.CAPTURE.DENIED: ${resource.id}`);
  
  const amount = parseFloat(resource.amount?.value || '0');
  const currency = resource.amount?.currency_code || 'USD';

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: `paypal_${resource.id}`,
    payment_key: `paypal_${resource.id}`,
    amount: amount,
    currency: currency,
    status: 'failed',
    source: 'paypal',
    failure_message: resource.status_details?.reason || 'Payment denied',
    stripe_created_at: resource.create_time || new Date().toISOString(),
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting denied PayPal transaction:', error);
}

async function handlePaymentRefunded(supabase: any, resource: any) {
  console.log(`💸 Processing PAYMENT.CAPTURE.REFUNDED: ${resource.id}`);
  
  const { error } = await supabase
    .from('transactions')
    .update({ status: 'refunded' })
    .eq('stripe_payment_intent_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating refunded PayPal transaction:', error);
  else console.log(`✅ PayPal transaction marked as refunded: ${resource.id}`);
}

async function handleSubscriptionUpdate(supabase: any, resource: any) {
  console.log(`📦 Processing subscription update: ${resource.id} (${resource.status})`);
  
  const billingInfo = resource.billing_info || {};
  const amount = parseFloat(billingInfo.last_payment?.amount?.value || '0');
  const currency = billingInfo.last_payment?.amount?.currency_code || 'USD';

  const { error } = await supabase.from('subscriptions').upsert({
    stripe_subscription_id: `paypal_${resource.id}`,
    status: resource.status?.toLowerCase() || 'active',
    plan_name: resource.plan_id || 'PayPal Plan',
    plan_id: resource.plan_id,
    amount: amount,
    currency: currency,
    current_period_start: resource.start_time,
    current_period_end: billingInfo.next_billing_time,
    provider: 'paypal',
  }, { onConflict: 'stripe_subscription_id' });

  if (error) console.error('Error upserting PayPal subscription:', error);
  else console.log(`✅ PayPal subscription upserted: ${resource.id}`);
}

async function handleSubscriptionCancelled(supabase: any, resource: any) {
  console.log(`🗑️ Processing subscription.cancelled: ${resource.id}`);
  
  const { error } = await supabase
    .from('subscriptions')
    .update({ 
      status: 'canceled',
      canceled_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating cancelled PayPal subscription:', error);
  else console.log(`✅ PayPal subscription marked as canceled: ${resource.id}`);
}

async function handleSubscriptionPaymentFailed(supabase: any, resource: any) {
  console.log(`❌ Processing subscription.payment.failed: ${resource.id}`);
  
  const { error } = await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating PayPal subscription payment failed:', error);
}
