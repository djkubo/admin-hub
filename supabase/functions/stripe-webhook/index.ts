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
        await handlePaymentFailed(supabase, stripe, pi);
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(supabase, invoice);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(supabase, stripe, invoice);
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
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        await handleDispute(supabase, dispute);
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

// ============================================
// HELPER: Get full customer details
// ============================================
async function getCustomerDetails(stripe: Stripe, customerId: string | null): Promise<{
  email: string | null;
  name: string | null;
  phone: string | null;
  stripeCustomerId: string | null;
}> {
  if (!customerId) return { email: null, name: null, phone: null, stripeCustomerId: null };
  
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && !customer.deleted) {
      return {
        email: customer.email,
        name: customer.name,
        phone: customer.phone,
        stripeCustomerId: customer.id
      };
    }
  } catch (e) {
    console.warn('Could not fetch customer:', e);
  }
  return { email: null, name: null, phone: null, stripeCustomerId: customerId };
}

// ============================================
// HELPER: Extract card info from PaymentIntent
// ============================================
function extractPaymentMethodInfo(pi: Stripe.PaymentIntent): {
  cardLast4: string | null;
  cardBrand: string | null;
  paymentMethodType: string | null;
} {
  const pm = pi.payment_method;
  if (pm && typeof pm === 'object') {
    const card = (pm as any).card;
    if (card) {
      return {
        cardLast4: card.last4 || null,
        cardBrand: card.brand || null,
        paymentMethodType: 'card'
      };
    }
  }
  return { cardLast4: null, cardBrand: null, paymentMethodType: null };
}

// ============================================
// HELPER: Get invoice description
// ============================================
async function getInvoiceDescription(stripe: Stripe, invoiceId: string | null): Promise<{
  description: string | null;
  invoiceNumber: string | null;
  subscriptionId: string | null;
  productName: string | null;
}> {
  if (!invoiceId) return { description: null, invoiceNumber: null, subscriptionId: null, productName: null };
  
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ['subscription', 'lines.data.price.product']
    });
    
    let productName = null;
    if (invoice.lines?.data?.[0]?.price?.product) {
      const product = invoice.lines.data[0].price.product;
      if (typeof product === 'object' && 'name' in product) {
        productName = product.name;
      }
    }
    
    return {
      description: invoice.description || `Invoice ${invoice.number}`,
      invoiceNumber: invoice.number,
      subscriptionId: invoice.subscription ? String(invoice.subscription) : null,
      productName
    };
  } catch (e) {
    console.warn('Could not fetch invoice:', e);
  }
  return { description: null, invoiceNumber: null, subscriptionId: null, productName: null };
}

// ============================================
// HELPER: Determine payment type
// ============================================
async function determinePaymentType(supabase: any, email: string | null, invoiceInfo: any): Promise<string> {
  if (!email) return 'renewal';
  
  // Check if this is their first payment
  const { data: existingPayments, error } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('customer_email', email.toLowerCase())
    .in('status', ['succeeded', 'paid'])
    .limit(1);
  
  if (error || !existingPayments || existingPayments.length === 0) {
    return 'new'; // First payment
  }
  
  // Check if it's from a subscription
  if (invoiceInfo?.subscriptionId) {
    // Could check trial status here
    return 'renewal';
  }
  
  return 'renewal';
}

// ============================================
// HELPER: Update client record with full info
// ============================================
async function upsertClient(supabase: any, data: {
  email: string;
  name?: string | null;
  phone?: string | null;
  stripeCustomerId?: string | null;
  isPaying?: boolean;
  paymentAmount?: number;
}) {
  const email = data.email.toLowerCase().trim();
  
  // Get existing client
  const { data: existing } = await supabase
    .from('clients')
    .select('id, total_paid, lifecycle_stage, full_name, phone')
    .eq('email', email)
    .single();
  
  const updateData: any = {
    email,
    last_sync: new Date().toISOString(),
  };
  
  // Only update name if we have it and don't already have one
  if (data.name && !existing?.full_name) {
    updateData.full_name = data.name;
  }
  
  // Only update phone if we have it and don't already have one
  if (data.phone && !existing?.phone) {
    updateData.phone = data.phone;
  }
  
  if (data.stripeCustomerId) {
    updateData.stripe_customer_id = data.stripeCustomerId;
  }
  
  if (data.isPaying) {
    updateData.lifecycle_stage = 'CUSTOMER';
    updateData.total_paid = (existing?.total_paid || 0) + (data.paymentAmount || 0);
    if (!existing?.first_payment_at) {
      updateData.first_payment_at = new Date().toISOString();
    }
  }
  
  const { error } = await supabase
    .from('clients')
    .upsert(updateData, { onConflict: 'email' });
  
  if (error) console.error('Error upserting client:', error);
}

// ============================================
// HANDLER: Payment Succeeded - ENHANCED
// ============================================
async function handlePaymentSucceeded(supabase: any, stripe: Stripe, pi: Stripe.PaymentIntent) {
  console.log(`💰 Processing payment_intent.succeeded: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  
  // Get all enrichment data in parallel
  const [customerDetails, invoiceInfo] = await Promise.all([
    getCustomerDetails(stripe, pi.customer ? String(pi.customer) : null),
    getInvoiceDescription(stripe, pi.invoice ? String(pi.invoice) : null)
  ]);
  
  const cardInfo = extractPaymentMethodInfo(pi);
  const paymentType = await determinePaymentType(supabase, customerDetails.email, invoiceInfo);

  // Build comprehensive metadata
  const enrichedMetadata = {
    ...pi.metadata,
    card_last4: cardInfo.cardLast4,
    card_brand: cardInfo.cardBrand,
    payment_method_type: cardInfo.paymentMethodType,
    invoice_number: invoiceInfo.invoiceNumber,
    product_name: invoiceInfo.productName,
    customer_name: customerDetails.name,
    customer_phone: customerDetails.phone,
  };

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: pi.id,
    payment_key: paymentKey,
    payment_type: paymentType,
    subscription_id: invoiceInfo.subscriptionId,
    amount: pi.amount, // Keep in cents
    currency: pi.currency?.toLowerCase() || 'usd',
    status: 'succeeded',
    stripe_customer_id: customerDetails.stripeCustomerId,
    customer_email: customerDetails.email?.toLowerCase(),
    source: 'stripe',
    external_transaction_id: pi.id,
    stripe_created_at: new Date(pi.created * 1000).toISOString(),
    metadata: enrichedMetadata,
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) {
    console.error('Error upserting transaction:', error);
  } else {
    console.log(`✅ Transaction upserted: ${pi.id} (${paymentType}, $${pi.amount/100})`);
    
    // Update client record
    if (customerDetails.email) {
      await upsertClient(supabase, {
        email: customerDetails.email,
        name: customerDetails.name,
        phone: customerDetails.phone,
        stripeCustomerId: customerDetails.stripeCustomerId,
        isPaying: true,
        paymentAmount: pi.amount,
      });
    }
  }
}

// ============================================
// HANDLER: Payment Failed - ENHANCED
// ============================================
async function handlePaymentFailed(supabase: any, stripe: Stripe, pi: Stripe.PaymentIntent) {
  console.log(`❌ Processing payment_intent.payment_failed: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  const lastError = pi.last_payment_error;
  
  // Get enrichment data
  const [customerDetails, invoiceInfo] = await Promise.all([
    getCustomerDetails(stripe, pi.customer ? String(pi.customer) : null),
    getInvoiceDescription(stripe, pi.invoice ? String(pi.invoice) : null)
  ]);
  
  const cardInfo = extractPaymentMethodInfo(pi);

  // Map Stripe decline codes to Spanish
  const declineReasonMap: Record<string, string> = {
    'insufficient_funds': 'Fondos insuficientes',
    'card_declined': 'Tarjeta rechazada',
    'expired_card': 'Tarjeta expirada',
    'incorrect_cvc': 'CVC incorrecto',
    'processing_error': 'Error de procesamiento',
    'do_not_honor': 'No aceptar',
    'generic_decline': 'Rechazo genérico',
    'lost_card': 'Tarjeta perdida',
    'stolen_card': 'Tarjeta robada',
    'transaction_not_allowed': 'Transacción no permitida',
    'pickup_card': 'Retener tarjeta',
    'blocked': 'Bloqueado',
  };

  const failureCode = lastError?.code || pi.status;
  const failureMessage = declineReasonMap[failureCode] || lastError?.message || failureCode;

  const enrichedMetadata = {
    ...pi.metadata,
    card_last4: cardInfo.cardLast4,
    card_brand: cardInfo.cardBrand,
    invoice_number: invoiceInfo.invoiceNumber,
    product_name: invoiceInfo.productName,
    customer_name: customerDetails.name,
    decline_reason_es: failureMessage,
  };

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: pi.id,
    payment_key: paymentKey,
    subscription_id: invoiceInfo.subscriptionId,
    amount: pi.amount,
    currency: pi.currency?.toLowerCase() || 'usd',
    status: 'failed',
    stripe_customer_id: customerDetails.stripeCustomerId,
    customer_email: customerDetails.email?.toLowerCase(),
    source: 'stripe',
    external_transaction_id: pi.id,
    failure_code: failureCode,
    failure_message: failureMessage,
    stripe_created_at: new Date(pi.created * 1000).toISOString(),
    metadata: enrichedMetadata,
  }, { onConflict: 'stripe_payment_intent_id' });

  if (error) console.error('Error upserting failed transaction:', error);
  else console.log(`✅ Failed transaction logged: ${pi.id} - ${failureMessage}`);

  // Update client if we have email
  if (customerDetails.email) {
    await upsertClient(supabase, {
      email: customerDetails.email,
      name: customerDetails.name,
      phone: customerDetails.phone,
      stripeCustomerId: customerDetails.stripeCustomerId,
    });
  }
}

// ============================================
// HANDLER: Invoice Paid
// ============================================
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

// ============================================
// HANDLER: Invoice Payment Failed - ENHANCED
// ============================================
async function handleInvoicePaymentFailed(supabase: any, stripe: Stripe, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice.payment_failed: ${invoice.id}`);
  
  // Get customer details for phone
  const customerDetails = await getCustomerDetails(stripe, invoice.customer ? String(invoice.customer) : null);
  
  // Get product name from line items
  let productName = null;
  if (invoice.lines?.data?.[0]?.description) {
    productName = invoice.lines.data[0].description;
  }

  const { error } = await supabase.from('invoices').upsert({
    stripe_invoice_id: invoice.id,
    stripe_customer_id: invoice.customer ? String(invoice.customer) : null,
    customer_email: invoice.customer_email?.toLowerCase(),
    customer_phone: customerDetails.phone,
    customer_name: customerDetails.name,
    amount_due: invoice.amount_due || 0, // Keep in cents
    currency: invoice.currency?.toLowerCase() || 'usd',
    status: 'open',
    hosted_invoice_url: invoice.hosted_invoice_url,
    invoice_number: invoice.number,
    description: productName || `Invoice ${invoice.number}`,
    next_payment_attempt: invoice.next_payment_attempt 
      ? new Date(invoice.next_payment_attempt * 1000).toISOString() 
      : null,
    period_end: invoice.period_end 
      ? new Date(invoice.period_end * 1000).toISOString() 
      : null,
  }, { onConflict: 'stripe_invoice_id' });

  if (error) console.error('Error upserting failed invoice:', error);
  else console.log(`✅ Failed invoice logged: ${invoice.id}`);
}

// ============================================
// HANDLER: Subscription Update - ENHANCED
// ============================================
async function handleSubscriptionUpdate(supabase: any, stripe: Stripe, sub: Stripe.Subscription) {
  console.log(`📦 Processing subscription update: ${sub.id} (${sub.status})`);
  
  let planName = 'Unknown Plan';
  let planId = null;
  let amount = 0;
  let interval = null;
  
  const customerDetails = await getCustomerDetails(stripe, sub.customer ? String(sub.customer) : null);

  // Get plan details
  if (sub.items?.data?.[0]?.price) {
    const price = sub.items.data[0].price;
    planId = price.id;
    amount = price.unit_amount || 0; // Keep in cents
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

  const { error } = await supabase.from('subscriptions').upsert({
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer ? String(sub.customer) : null,
    customer_email: customerDetails.email?.toLowerCase(),
    customer_name: customerDetails.name,
    customer_phone: customerDetails.phone,
    status: sub.status,
    plan_name: planName,
    plan_id: planId,
    amount: amount,
    currency: sub.currency?.toLowerCase() || 'usd',
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
  else console.log(`✅ Subscription upserted: ${sub.id} - ${planName}`);

  // Update client
  if (customerDetails.email) {
    await upsertClient(supabase, {
      email: customerDetails.email,
      name: customerDetails.name,
      phone: customerDetails.phone,
      stripeCustomerId: customerDetails.stripeCustomerId,
    });
  }
}

// ============================================
// HANDLER: Subscription Deleted
// ============================================
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

// ============================================
// HANDLER: Refund
// ============================================
async function handleRefund(supabase: any, charge: Stripe.Charge) {
  console.log(`💸 Processing charge.refunded: ${charge.id}`);
  
  const piId = charge.payment_intent ? String(charge.payment_intent) : null;
  if (!piId) {
    console.warn('Refund charge has no payment_intent, skipping');
    return;
  }

  const { error } = await supabase
    .from('transactions')
    .update({ 
      status: 'refunded',
      metadata: { refunded_at: new Date().toISOString() }
    })
    .eq('stripe_payment_intent_id', piId);

  if (error) console.error('Error updating refunded transaction:', error);
  else console.log(`✅ Transaction marked as refunded: ${piId}`);
}

// ============================================
// HANDLER: Dispute (Chargeback)
// ============================================
async function handleDispute(supabase: any, dispute: Stripe.Dispute) {
  console.log(`⚠️ Processing charge.dispute.created: ${dispute.id}`);
  
  const chargeId = dispute.charge ? String(dispute.charge) : null;
  
  // Log dispute
  const { error } = await supabase.from('disputes').upsert({
    stripe_dispute_id: dispute.id,
    stripe_charge_id: chargeId,
    amount: dispute.amount,
    currency: dispute.currency?.toLowerCase() || 'usd',
    status: dispute.status,
    reason: dispute.reason,
    created_at: new Date(dispute.created * 1000).toISOString(),
  }, { onConflict: 'stripe_dispute_id' });

  if (error) console.error('Error upserting dispute:', error);
  else console.log(`✅ Dispute logged: ${dispute.id} - ${dispute.reason}`);
}
