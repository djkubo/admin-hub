import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, paypal-transmission-id, paypal-transmission-time, paypal-transmission-sig, paypal-cert-url, paypal-auth-algo',
};

async function getPayPalAccessToken(clientId: string, secret: string, isSandbox: boolean): Promise<string> {
  const baseUrl = isSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  console.log(`🔑 Getting PayPal token from ${isSandbox ? 'SANDBOX' : 'LIVE'}`);
  
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${clientId}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`PayPal auth failed: ${response.status} - ${errorText}`);
    throw new Error(`PayPal auth failed: ${response.status}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

async function verifyWebhookSignature(
  accessToken: string,
  webhookId: string,
  headers: Headers,
  body: string,
  isSandbox: boolean
): Promise<boolean> {
  const transmissionId = headers.get('paypal-transmission-id');
  const transmissionTime = headers.get('paypal-transmission-time');
  const transmissionSig = headers.get('paypal-transmission-sig');
  const certUrl = headers.get('paypal-cert-url');
  const authAlgo = headers.get('paypal-auth-algo');

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

  const baseUrl = isSandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  const response = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(verifyPayload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error(`❌ PayPal verification failed: ${response.status} - ${responseText}`);
    return false;
  }

  const result = JSON.parse(responseText);
  return result.verification_status === 'SUCCESS';
}

function isSandboxEvent(headers: Headers): boolean {
  const certUrl = headers.get('paypal-cert-url') || '';
  return certUrl.includes('sandbox');
}

// Extract payer info from PayPal resource
function extractPayerInfo(resource: any): {
  email: string | null;
  name: string | null;
  payerId: string | null;
} {
  // Try different locations where PayPal puts payer info
  const payer = resource.payer || resource.subscriber || {};
  
  const email = payer.email_address || payer.email || null;
  let name = null;
  const payerId = payer.payer_id || null;
  
  if (payer.name) {
    if (typeof payer.name === 'string') {
      name = payer.name;
    } else {
      name = [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ');
    }
  }
  
  // Also check shipping info for name
  if (!name && resource.shipping?.name?.full_name) {
    name = resource.shipping.name.full_name;
  }
  
  return { email, name, payerId };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const clientId = Deno.env.get('PAYPAL_CLIENT_ID');
  const secret = Deno.env.get('PAYPAL_SECRET');
  const webhookId = Deno.env.get('PAYPAL_WEBHOOK_ID');

  if (!clientId || !secret || !webhookId) {
    console.error('❌ paypal-webhook: Missing credentials');
    return new Response(
      JSON.stringify({ error: 'Webhook not configured' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const body = await req.text();
  const isSandbox = isSandboxEvent(req.headers);
  
  try {
    const accessToken = await getPayPalAccessToken(clientId, secret, isSandbox);
    const isValid = await verifyWebhookSignature(accessToken, webhookId, req.headers, body, isSandbox);

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
      console.log(`⚠️ paypal-webhook: Event ${event.id} already processed`);
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Log event
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
      case 'PAYMENT.CAPTURE.DECLINED':
        await handlePaymentDenied(supabase, event.resource);
        break;
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentRefunded(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.CREATED':
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.UPDATED':
        await handleSubscriptionUpdate(supabase, event.resource);
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        await handleSubscriptionCancelled(supabase, event.resource, event.event_type);
        break;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await handleSubscriptionPaymentFailed(supabase, event.resource);
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await handleSaleCompleted(supabase, event.resource);
        break;
      default:
        console.log(`ℹ️ paypal-webhook: Unhandled event ${event.event_type}`);
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

// ============================================
// HELPER: Upsert client
// ============================================
async function upsertClient(supabase: any, data: {
  email: string;
  name?: string | null;
  paypalPayerId?: string | null;
  isPaying?: boolean;
  paymentAmount?: number;
}) {
  const email = data.email.toLowerCase().trim();
  
  const { data: existing } = await supabase
    .from('clients')
    .select('id, total_paid, lifecycle_stage, full_name')
    .eq('email', email)
    .single();
  
  const updateData: any = {
    email,
    last_sync: new Date().toISOString(),
  };
  
  if (data.name && !existing?.full_name) {
    updateData.full_name = data.name;
  }
  
  if (data.isPaying) {
    updateData.lifecycle_stage = 'CUSTOMER';
    updateData.total_paid = (existing?.total_paid || 0) + (data.paymentAmount || 0);
    if (!existing?.converted_at) {
      updateData.converted_at = new Date().toISOString();
    }
  }
  
  // Store PayPal payer ID in metadata
  if (data.paypalPayerId) {
    updateData.customer_metadata = {
      ...(existing?.customer_metadata || {}),
      paypal_payer_id: data.paypalPayerId
    };
  }
  
  const { error } = await supabase
    .from('clients')
    .upsert(updateData, { onConflict: 'email' });
  
  if (error) console.error('Error upserting client:', error);
}

// ============================================
// HANDLER: Payment Completed - ENHANCED
// ============================================
async function handlePaymentCompleted(supabase: any, resource: any) {
  console.log(`💰 Processing PAYMENT.CAPTURE.COMPLETED: ${resource.id}`);
  
  const amount = parseFloat(resource.amount?.value || '0');
  const currency = resource.amount?.currency_code || 'USD';
  const fee = parseFloat(resource.seller_receivable_breakdown?.paypal_fee?.value || '0');
  const netAmount = parseFloat(resource.seller_receivable_breakdown?.net_amount?.value || amount.toString());
  
  const payerInfo = extractPayerInfo(resource);

  const enrichedMetadata = {
    paypal_transaction_id: resource.id,
    paypal_payer_id: payerInfo.payerId,
    customer_name: payerInfo.name,
    gross_amount: amount,
    fee_amount: fee,
    net_amount: netAmount,
    invoice_id: resource.invoice_id || null,
  };

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: `paypal_${resource.id}`,
    payment_key: resource.id,
    amount: Math.round(amount * 100), // Convert to cents
    currency: currency.toLowerCase(),
    status: 'paid',
    source: 'paypal',
    external_transaction_id: resource.id,
    customer_email: payerInfo.email?.toLowerCase(),
    stripe_created_at: resource.create_time || new Date().toISOString(),
    metadata: enrichedMetadata,
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) {
    console.error('Error upserting PayPal transaction:', error);
  } else {
    console.log(`✅ PayPal transaction: ${resource.id} - ${payerInfo.name || payerInfo.email} - $${amount}`);
    
    if (payerInfo.email) {
      await upsertClient(supabase, {
        email: payerInfo.email,
        name: payerInfo.name,
        paypalPayerId: payerInfo.payerId,
        isPaying: true,
        paymentAmount: Math.round(amount * 100),
      });
    }
  }
}

// ============================================
// HANDLER: Payment Denied
// ============================================
async function handlePaymentDenied(supabase: any, resource: any) {
  console.log(`❌ Processing PAYMENT.CAPTURE.DENIED: ${resource.id}`);
  
  const amount = parseFloat(resource.amount?.value || '0');
  const currency = resource.amount?.currency_code || 'USD';
  const payerInfo = extractPayerInfo(resource);
  
  const failureReason = resource.status_details?.reason || 'Payment denied';

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: `paypal_${resource.id}`,
    payment_key: resource.id,
    amount: Math.round(amount * 100),
    currency: currency.toLowerCase(),
    status: 'failed',
    source: 'paypal',
    external_transaction_id: resource.id,
    customer_email: payerInfo.email?.toLowerCase(),
    failure_code: 'DENIED',
    failure_message: failureReason,
    stripe_created_at: resource.create_time || new Date().toISOString(),
    metadata: {
      customer_name: payerInfo.name,
      paypal_payer_id: payerInfo.payerId,
    },
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting denied PayPal transaction:', error);
  
  if (payerInfo.email) {
    await upsertClient(supabase, {
      email: payerInfo.email,
      name: payerInfo.name,
      paypalPayerId: payerInfo.payerId,
    });
  }
}

// ============================================
// HANDLER: Payment Refunded
// ============================================
async function handlePaymentRefunded(supabase: any, resource: any) {
  console.log(`💸 Processing PAYMENT.CAPTURE.REFUNDED: ${resource.id}`);
  
  const { error } = await supabase
    .from('transactions')
    .update({ 
      status: 'refunded',
      metadata: { refunded_at: new Date().toISOString() }
    })
    .eq('stripe_payment_intent_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating refunded PayPal transaction:', error);
  else console.log(`✅ PayPal refund processed: ${resource.id}`);
}

// ============================================
// HANDLER: Sale Completed (recurring payment)
// ============================================
async function handleSaleCompleted(supabase: any, resource: any) {
  console.log(`💰 Processing PAYMENT.SALE.COMPLETED: ${resource.id}`);
  
  const amount = parseFloat(resource.amount?.total || '0');
  const currency = resource.amount?.currency || 'USD';
  const payerInfo = extractPayerInfo(resource);

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: `paypal_sale_${resource.id}`,
    payment_key: resource.id,
    payment_type: 'renewal',
    subscription_id: resource.billing_agreement_id || null,
    amount: Math.round(amount * 100),
    currency: currency.toLowerCase(),
    status: 'paid',
    source: 'paypal',
    external_transaction_id: resource.id,
    customer_email: payerInfo.email?.toLowerCase(),
    stripe_created_at: resource.create_time || new Date().toISOString(),
    metadata: {
      customer_name: payerInfo.name,
      paypal_payer_id: payerInfo.payerId,
      billing_agreement_id: resource.billing_agreement_id,
    },
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting PayPal sale:', error);
  else console.log(`✅ PayPal recurring sale: ${resource.id}`);
  
  if (payerInfo.email) {
    await upsertClient(supabase, {
      email: payerInfo.email,
      name: payerInfo.name,
      paypalPayerId: payerInfo.payerId,
      isPaying: true,
      paymentAmount: Math.round(amount * 100),
    });
  }
}

// ============================================
// HANDLER: Subscription Update - ENHANCED
// ============================================
async function handleSubscriptionUpdate(supabase: any, resource: any) {
  console.log(`📦 Processing subscription: ${resource.id} (${resource.status})`);
  
  const billingInfo = resource.billing_info || {};
  const amount = parseFloat(billingInfo.last_payment?.amount?.value || '0');
  const currency = billingInfo.last_payment?.amount?.currency_code || 'USD';
  const payerInfo = extractPayerInfo(resource);

  const { error } = await supabase.from('subscriptions').upsert({
    stripe_subscription_id: `paypal_${resource.id}`,
    customer_email: payerInfo.email?.toLowerCase(),
    customer_name: payerInfo.name,
    status: resource.status?.toLowerCase() || 'active',
    plan_name: resource.plan_id || 'PayPal Plan',
    plan_id: resource.plan_id,
    amount: Math.round(amount * 100),
    currency: currency.toLowerCase(),
    current_period_start: resource.start_time,
    current_period_end: billingInfo.next_billing_time,
    provider: 'paypal',
    metadata: {
      paypal_payer_id: payerInfo.payerId,
      billing_cycles: billingInfo.cycle_executions,
    },
  }, { onConflict: 'stripe_subscription_id' });

  if (error) console.error('Error upserting PayPal subscription:', error);
  else console.log(`✅ PayPal subscription: ${resource.id} - ${payerInfo.name || payerInfo.email}`);
  
  if (payerInfo.email) {
    await upsertClient(supabase, {
      email: payerInfo.email,
      name: payerInfo.name,
      paypalPayerId: payerInfo.payerId,
    });
  }
}

// ============================================
// HANDLER: Subscription Cancelled
// ============================================
async function handleSubscriptionCancelled(supabase: any, resource: any, eventType: string) {
  console.log(`🗑️ Processing ${eventType}: ${resource.id}`);
  
  const statusMap: Record<string, string> = {
    'BILLING.SUBSCRIPTION.CANCELLED': 'canceled',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended',
    'BILLING.SUBSCRIPTION.EXPIRED': 'expired',
  };
  
  const { error } = await supabase
    .from('subscriptions')
    .update({ 
      status: statusMap[eventType] || 'canceled',
      canceled_at: new Date().toISOString()
    })
    .eq('stripe_subscription_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating PayPal subscription:', error);
  else console.log(`✅ PayPal subscription ${statusMap[eventType]}: ${resource.id}`);
}

// ============================================
// HANDLER: Subscription Payment Failed
// ============================================
async function handleSubscriptionPaymentFailed(supabase: any, resource: any) {
  console.log(`❌ Processing subscription.payment.failed: ${resource.id}`);
  
  const { error } = await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', `paypal_${resource.id}`);

  if (error) console.error('Error updating PayPal subscription:', error);
}
