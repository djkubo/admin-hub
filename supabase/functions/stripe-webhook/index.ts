import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
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
  const { data: existingRows, error: existingLookupError } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('source', 'stripe')
    .eq('event_id', event.id)
    .limit(1);

  if (existingLookupError) {
    console.error('❌ stripe-webhook: Failed idempotency lookup:', existingLookupError.message);
    return new Response(
      JSON.stringify({ error: 'Idempotency lookup failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const existing = Array.isArray(existingRows) ? existingRows[0] : null;

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
        await handleInvoicePaid(supabase, stripe, invoice);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(supabase, stripe, invoice);
        break;
      }
      case 'invoice.created':
      case 'invoice.updated':
      case 'invoice.finalized': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoiceUpsert(supabase, stripe, invoice);
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
// HELPER: Resolve client via unify_identity
// ============================================
async function resolveClientViaUnify(
  supabase: SupabaseClient,
  stripeCustomerId: string | null,
  email: string | null,
  phone: string | null,
  fullName: string | null
): Promise<string | null> {
  if (!stripeCustomerId && !email && !phone) return null;

  try {
    const { data, error } = await supabase.rpc('unify_identity', {
      p_source: 'stripe',
      p_stripe_customer_id: stripeCustomerId,
      p_email: email?.toLowerCase() || null,
      p_phone: phone,
      p_full_name: fullName,
    });

    if (error) {
      console.warn('unify_identity error:', error.message);
      return null;
    }

    if (data?.success && data?.client_id) {
      console.log(`✅ unify_identity: ${data.action} -> ${data.client_id}`);
      return data.client_id;
    }
  } catch (e) {
    console.warn('unify_identity failed:', e);
  }

  return null;
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
async function determinePaymentType(supabase: SupabaseClient, email: string | null, invoiceInfo: any): Promise<string> {
  if (!email) return 'renewal';
  
  const { data: existingPayments, error } = await supabase
    .from('transactions')
    .select('id, status')
    .eq('customer_email', email.toLowerCase())
    .in('status', ['succeeded', 'paid'])
    .limit(1);
  
  if (error || !existingPayments || existingPayments.length === 0) {
    return 'new';
  }
  
  if (invoiceInfo?.subscriptionId) {
    return 'renewal';
  }
  
  return 'renewal';
}

// ============================================
// HELPER: Extract plan info from invoice
// ============================================
function extractPlanInfo(invoice: Stripe.Invoice): { 
  planName: string | null; 
  planInterval: string | null; 
  productName: string | null 
} {
  let planName: string | null = null;
  let planInterval: string | null = null;
  let productName: string | null = null;

  if (invoice.lines?.data?.length) {
    const firstLine = invoice.lines.data[0];
    if (firstLine.price) {
      planName = firstLine.price.nickname || firstLine.description || null;
      planInterval = firstLine.price.recurring?.interval || null;
      if (firstLine.price.product && typeof firstLine.price.product === 'object') {
        productName = (firstLine.price.product as any).name;
      }
    } else if (firstLine.description) {
      planName = firstLine.description;
    }
  }

  if (planInterval) {
    const intervalMap: Record<string, string> = {
      'day': 'Diario',
      'week': 'Semanal',
      'month': 'Mensual',
      'year': 'Anual',
    };
    planInterval = intervalMap[planInterval] || planInterval;
  }

  return { planName, planInterval, productName };
}

// ============================================
// HANDLER: Payment Succeeded - ENHANCED
// ============================================
async function handlePaymentSucceeded(supabase: SupabaseClient, stripe: Stripe, pi: Stripe.PaymentIntent) {
  console.log(`💰 Processing payment_intent.succeeded: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  
  const [customerDetails, invoiceInfo] = await Promise.all([
    getCustomerDetails(stripe, pi.customer ? String(pi.customer) : null),
    getInvoiceDescription(stripe, pi.invoice ? String(pi.invoice) : null)
  ]);
  
  const cardInfo = extractPaymentMethodInfo(pi);
  const paymentType = await determinePaymentType(supabase, customerDetails.email, invoiceInfo);

  // Resolve client via unify_identity
  const clientId = await resolveClientViaUnify(
    supabase,
    customerDetails.stripeCustomerId,
    customerDetails.email,
    customerDetails.phone,
    customerDetails.name
  );

  const enrichedMetadata = {
    ...pi.metadata,
    card_last4: cardInfo.cardLast4,
    card_brand: cardInfo.cardBrand,
    payment_method_type: cardInfo.paymentMethodType,
    invoice_number: invoiceInfo.invoiceNumber,
    product_name: invoiceInfo.productName,
    customer_name: customerDetails.name,
    customer_phone: customerDetails.phone,
    client_id: clientId,
  };

  const { error } = await supabase.from('transactions').upsert({
    stripe_payment_intent_id: pi.id,
    payment_key: paymentKey,
    payment_type: paymentType,
    subscription_id: invoiceInfo.subscriptionId,
    amount: pi.amount,
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
  }
}

// ============================================
// HANDLER: Payment Failed - ENHANCED
// ============================================
async function handlePaymentFailed(supabase: SupabaseClient, stripe: Stripe, pi: Stripe.PaymentIntent) {
  console.log(`❌ Processing payment_intent.payment_failed: ${pi.id}`);
  
  const paymentKey = pi.invoice ? String(pi.invoice) : pi.id;
  const lastError = pi.last_payment_error;
  
  const [customerDetails, invoiceInfo] = await Promise.all([
    getCustomerDetails(stripe, pi.customer ? String(pi.customer) : null),
    getInvoiceDescription(stripe, pi.invoice ? String(pi.invoice) : null)
  ]);
  
  const cardInfo = extractPaymentMethodInfo(pi);

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

  const clientId = await resolveClientViaUnify(
    supabase,
    customerDetails.stripeCustomerId,
    customerDetails.email,
    customerDetails.phone,
    customerDetails.name
  );

  const enrichedMetadata = {
    ...pi.metadata,
    card_last4: cardInfo.cardLast4,
    card_brand: cardInfo.cardBrand,
    invoice_number: invoiceInfo.invoiceNumber,
    product_name: invoiceInfo.productName,
    customer_name: customerDetails.name,
    decline_reason_es: failureMessage,
    client_id: clientId,
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
}

// ============================================
// HANDLER: Invoice Paid - UPSERT (NO DELETE!)
// ============================================
async function handleInvoicePaid(supabase: SupabaseClient, stripe: Stripe, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice.paid: ${invoice.id}`);
  
  // Get customer details for enrichment
  const customerDetails = await getCustomerDetails(stripe, invoice.customer ? String(invoice.customer) : null);
  
  // Resolve client via unify_identity
  const clientId = await resolveClientViaUnify(
    supabase,
    customerDetails.stripeCustomerId,
    invoice.customer_email || customerDetails.email,
    customerDetails.phone,
    invoice.customer_name || customerDetails.name
  );

  const { planName, planInterval, productName } = extractPlanInfo(invoice);

  // Get subscription ID
  const subscriptionId = invoice.subscription 
    ? (typeof invoice.subscription === 'object' ? invoice.subscription.id : invoice.subscription)
    : null;

  // Get payment intent ID
  const paymentIntentId = invoice.payment_intent
    ? (typeof invoice.payment_intent === 'object' ? invoice.payment_intent.id : invoice.payment_intent)
    : null;

  // UPSERT with status=paid and paid_at - NEVER DELETE
  const { error } = await supabase.from('invoices').upsert({
    stripe_invoice_id: invoice.id,
    invoice_number: invoice.number,
    stripe_customer_id: customerDetails.stripeCustomerId,
    customer_email: (invoice.customer_email || customerDetails.email)?.toLowerCase(),
    customer_name: invoice.customer_name || customerDetails.name,
    customer_phone: customerDetails.phone,
    client_id: clientId,
    amount_due: invoice.amount_due,
    amount_paid: invoice.amount_paid,
    amount_remaining: invoice.amount_remaining || 0,
    subtotal: invoice.subtotal,
    total: invoice.total,
    currency: invoice.currency?.toLowerCase() || 'usd',
    status: 'paid',
    paid_at: new Date().toISOString(),
    stripe_created_at: invoice.created 
      ? new Date(invoice.created * 1000).toISOString() 
      : null,
    finalized_at: invoice.status_transitions?.finalized_at
      ? new Date(invoice.status_transitions.finalized_at * 1000).toISOString()
      : null,
    period_end: invoice.period_end 
      ? new Date(invoice.period_end * 1000).toISOString() 
      : null,
    hosted_invoice_url: invoice.hosted_invoice_url,
    pdf_url: invoice.invoice_pdf,
    subscription_id: subscriptionId,
    payment_intent_id: paymentIntentId,
    plan_name: planName,
    plan_interval: planInterval,
    product_name: productName,
    attempt_count: invoice.attempt_count || 0,
    billing_reason: invoice.billing_reason,
    collection_method: invoice.collection_method,
    raw_data: invoice as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_invoice_id' });

  if (error) console.error('Error upserting paid invoice:', error);
  else console.log(`✅ Invoice marked as paid: ${invoice.id} (client: ${clientId})`);
}

// ============================================
// HANDLER: Invoice Payment Failed - ENHANCED + RECOVERY QUEUE
// ============================================
async function handleInvoicePaymentFailed(supabase: SupabaseClient, stripe: Stripe, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice.payment_failed: ${invoice.id}`);
  
  const customerDetails = await getCustomerDetails(stripe, invoice.customer ? String(invoice.customer) : null);
  
  const clientId = await resolveClientViaUnify(
    supabase,
    customerDetails.stripeCustomerId,
    invoice.customer_email || customerDetails.email,
    customerDetails.phone,
    invoice.customer_name || customerDetails.name
  );

  const { planName, planInterval, productName } = extractPlanInfo(invoice);

  // Get the last payment error to determine failure reason
  let failureReason = 'unknown';
  let failureMessage = 'Pago fallido';
  
  if (invoice.payment_intent) {
    try {
      const piId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent.id;
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.last_payment_error) {
        failureReason = pi.last_payment_error.code || 'unknown';
        const declineMap: Record<string, string> = {
          'insufficient_funds': 'Fondos insuficientes',
          'card_declined': 'Tarjeta rechazada',
          'expired_card': 'Tarjeta expirada',
          'incorrect_cvc': 'CVC incorrecto',
          'processing_error': 'Error de procesamiento',
          'do_not_honor': 'No aceptar',
        };
        failureMessage = declineMap[failureReason] || pi.last_payment_error.message || failureReason;
      }
    } catch (piError) {
      console.warn('Could not fetch payment intent for failure reason:', piError);
    }
  }

  // Upsert invoice record
  const { error } = await supabase.from('invoices').upsert({
    stripe_invoice_id: invoice.id,
    stripe_customer_id: invoice.customer ? String(invoice.customer) : null,
    customer_email: (invoice.customer_email || customerDetails.email)?.toLowerCase(),
    customer_phone: customerDetails.phone,
    customer_name: invoice.customer_name || customerDetails.name,
    client_id: clientId,
    amount_due: invoice.amount_due || 0,
    currency: invoice.currency?.toLowerCase() || 'usd',
    status: 'open',
    hosted_invoice_url: invoice.hosted_invoice_url,
    invoice_number: invoice.number,
    plan_name: planName,
    plan_interval: planInterval,
    product_name: productName,
    next_payment_attempt: invoice.next_payment_attempt 
      ? new Date(invoice.next_payment_attempt * 1000).toISOString() 
      : null,
    period_end: invoice.period_end 
      ? new Date(invoice.period_end * 1000).toISOString() 
      : null,
    stripe_created_at: invoice.created 
      ? new Date(invoice.created * 1000).toISOString() 
      : null,
    raw_data: invoice as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_invoice_id' });

  if (error) console.error('Error upserting failed invoice:', error);
  else console.log(`✅ Failed invoice logged: ${invoice.id}`);

  // ============================================
  // RECOVERY QUEUE INTEGRATION
  // ============================================
  
  // Only add to recovery queue for recoverable failures
  const recoverableReasons = ['insufficient_funds', 'card_declined', 'processing_error', 'do_not_honor', 'unknown'];
  const shouldQueueForRecovery = recoverableReasons.includes(failureReason);

  if (shouldQueueForRecovery && customerDetails.stripeCustomerId) {
    console.log(`🔄 Adding to recovery queue: ${invoice.id} (${failureReason})`);
    
    // Calculate retry_at (48 hours from now)
    const retryAt = new Date();
    retryAt.setHours(retryAt.getHours() + 48);

    // Check if already in queue
    const { data: existingQueue } = await supabase
      .from('recovery_queue')
      .select('id, status')
      .eq('invoice_id', invoice.id)
      .single();

    if (existingQueue && ['recovered', 'cancelled'].includes(existingQueue.status)) {
      console.log(`ℹ️ Invoice ${invoice.id} already processed in recovery queue, skipping`);
    } else {
      // Generate payment link for the customer
      let portalLinkToken: string | null = null;
      try {
        const linkResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-payment-link`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
          body: JSON.stringify({
            stripe_customer_id: customerDetails.stripeCustomerId,
            invoice_id: invoice.id,
            client_id: clientId,
            customer_email: invoice.customer_email || customerDetails.email,
            customer_name: invoice.customer_name || customerDetails.name,
          }),
        });

        if (linkResponse.ok) {
          const linkResult = await linkResponse.json();
          portalLinkToken = linkResult.token;
          console.log(`🔗 Payment link generated: ${linkResult.url}`);
        }
      } catch (linkError) {
        console.warn('Could not generate payment link:', linkError);
      }

      // Upsert into recovery queue
      const { error: queueError } = await supabase.from('recovery_queue').upsert({
        invoice_id: invoice.id,
        client_id: clientId,
        stripe_customer_id: customerDetails.stripeCustomerId,
        customer_email: (invoice.customer_email || customerDetails.email)?.toLowerCase(),
        customer_phone: customerDetails.phone,
        customer_name: invoice.customer_name || customerDetails.name,
        amount_due: invoice.amount_due || 0,
        currency: invoice.currency?.toLowerCase() || 'usd',
        failure_reason: failureReason,
        failure_message: failureMessage,
        retry_at: retryAt.toISOString(),
        status: 'pending',
        portal_link_token: portalLinkToken,
      }, { onConflict: 'invoice_id' });

      if (queueError) {
        console.error('Error adding to recovery queue:', queueError);
      } else {
        console.log(`✅ Added to recovery queue: ${invoice.id}`);
        
        // Send initial notification if phone available
        if (customerDetails.phone && portalLinkToken) {
          try {
            const baseUrl = Deno.env.get('APP_URL') || 'https://zen-admin-joy.lovable.app';
            const portalLink = `${baseUrl}/update-card?token=${portalLinkToken}`;
            
            await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-sms`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                to: customerDetails.phone,
                message: `Hola ${invoice.customer_name || customerDetails.name || 'Cliente'} 👋\n\nTu pago de $${((invoice.amount_due || 0) / 100).toFixed(2)} no se procesó (${failureMessage}).\n\nPara evitar la suspensión de tu servicio, actualiza tu método de pago aquí:\n${portalLink}\n\n¿Necesitas ayuda? Responde a este mensaje.`,
                client_id: clientId,
              }),
            });
            
            // Mark notification as sent
            await supabase
              .from('recovery_queue')
              .update({ 
                notification_sent_at: new Date().toISOString(),
                notification_channel: 'sms',
                status: 'notified',
              })
              .eq('invoice_id', invoice.id);
              
            console.log(`📱 Initial recovery notification sent to ${customerDetails.phone}`);
          } catch (smsError) {
            console.warn('Could not send SMS notification:', smsError);
          }
        }
      }
    }
  }
}

// ============================================
// HANDLER: Invoice Created/Updated/Finalized
// ============================================
async function handleInvoiceUpsert(supabase: SupabaseClient, stripe: Stripe, invoice: Stripe.Invoice) {
  console.log(`📄 Processing invoice upsert: ${invoice.id} (${invoice.status})`);
  
  const customerDetails = await getCustomerDetails(stripe, invoice.customer ? String(invoice.customer) : null);
  
  const clientId = await resolveClientViaUnify(
    supabase,
    customerDetails.stripeCustomerId,
    invoice.customer_email || customerDetails.email,
    customerDetails.phone,
    invoice.customer_name || customerDetails.name
  );

  const { planName, planInterval, productName } = extractPlanInfo(invoice);

  const subscriptionId = invoice.subscription 
    ? (typeof invoice.subscription === 'object' ? invoice.subscription.id : invoice.subscription)
    : null;

  const paymentIntentId = invoice.payment_intent
    ? (typeof invoice.payment_intent === 'object' ? invoice.payment_intent.id : invoice.payment_intent)
    : null;

  const { error } = await supabase.from('invoices').upsert({
    stripe_invoice_id: invoice.id,
    invoice_number: invoice.number,
    stripe_customer_id: customerDetails.stripeCustomerId,
    customer_email: (invoice.customer_email || customerDetails.email)?.toLowerCase(),
    customer_name: invoice.customer_name || customerDetails.name,
    customer_phone: customerDetails.phone,
    client_id: clientId,
    amount_due: invoice.amount_due,
    amount_paid: invoice.amount_paid || 0,
    amount_remaining: invoice.amount_remaining,
    subtotal: invoice.subtotal,
    total: invoice.total,
    currency: invoice.currency?.toLowerCase() || 'usd',
    status: invoice.status,
    stripe_created_at: invoice.created 
      ? new Date(invoice.created * 1000).toISOString() 
      : null,
    finalized_at: invoice.status_transitions?.finalized_at
      ? new Date(invoice.status_transitions.finalized_at * 1000).toISOString()
      : null,
    automatically_finalizes_at: invoice.automatically_finalizes_at
      ? new Date(invoice.automatically_finalizes_at * 1000).toISOString()
      : null,
    period_end: invoice.period_end 
      ? new Date(invoice.period_end * 1000).toISOString() 
      : null,
    due_date: invoice.due_date
      ? new Date(invoice.due_date * 1000).toISOString()
      : null,
    next_payment_attempt: invoice.next_payment_attempt
      ? new Date(invoice.next_payment_attempt * 1000).toISOString()
      : null,
    hosted_invoice_url: invoice.hosted_invoice_url,
    pdf_url: invoice.invoice_pdf,
    subscription_id: subscriptionId,
    payment_intent_id: paymentIntentId,
    plan_name: planName,
    plan_interval: planInterval,
    product_name: productName,
    attempt_count: invoice.attempt_count || 0,
    billing_reason: invoice.billing_reason,
    collection_method: invoice.collection_method,
    description: invoice.description,
    raw_data: invoice as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'stripe_invoice_id' });

  if (error) console.error('Error upserting invoice:', error);
  else console.log(`✅ Invoice upserted: ${invoice.id} (${invoice.status})`);
}

// ============================================
// HANDLER: Subscription Update - ENHANCED
// ============================================
async function handleSubscriptionUpdate(supabase: SupabaseClient, stripe: Stripe, sub: Stripe.Subscription) {
  console.log(`📦 Processing subscription update: ${sub.id} (${sub.status})`);
  
  let planName = 'Unknown Plan';
  let planId = null;
  let amount = 0;
  let interval = null;
  
  const customerDetails = await getCustomerDetails(stripe, sub.customer ? String(sub.customer) : null);

  if (sub.items?.data?.[0]?.price) {
    const price = sub.items.data[0].price;
    planId = price.id;
    amount = price.unit_amount || 0;
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
}

// ============================================
// HANDLER: Subscription Deleted
// ============================================
async function handleSubscriptionDeleted(supabase: SupabaseClient, sub: Stripe.Subscription) {
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
async function handleRefund(supabase: SupabaseClient, charge: Stripe.Charge) {
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
async function handleDispute(supabase: SupabaseClient, dispute: Stripe.Dispute) {
  console.log(`⚠️ Processing charge.dispute.created: ${dispute.id}`);
  
  const { error } = await supabase.from('disputes').upsert({
    external_dispute_id: dispute.id,
    charge_id: dispute.charge ? String(dispute.charge) : null,
    amount: dispute.amount,
    currency: dispute.currency?.toLowerCase() || 'usd',
    status: dispute.status,
    reason: dispute.reason,
    source: 'stripe',
    created_at_external: new Date(dispute.created * 1000).toISOString(),
  }, { onConflict: 'external_dispute_id' });

  if (error) console.error('Error upserting dispute:', error);
  else console.log(`✅ Dispute logged: ${dispute.id} - ${dispute.reason}`);
}
