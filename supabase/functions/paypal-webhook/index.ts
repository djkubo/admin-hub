import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// SECURITY: CORS headers for PayPal webhook
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // PayPal servers need access
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, paypal-transmission-id, paypal-transmission-time, paypal-transmission-sig, paypal-cert-url, paypal-auth-algo',
};

interface PayPalEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
  create_time: string;
}

// Verify PayPal webhook signature using official API
async function verifyPayPalWebhook(req: Request, body: string): Promise<{ verified: boolean; error?: string }> {
  const webhookId = Deno.env.get('PAYPAL_WEBHOOK_ID');
  const clientId = Deno.env.get('PAYPAL_CLIENT_ID');
  const clientSecret = Deno.env.get('PAYPAL_SECRET');
  
  if (!webhookId) {
    return { verified: false, error: 'PAYPAL_WEBHOOK_ID not configured' };
  }

  if (!clientId || !clientSecret) {
    return { verified: false, error: 'PAYPAL_CLIENT_ID or PAYPAL_SECRET not configured' };
  }

  const transmissionId = req.headers.get('paypal-transmission-id');
  const transmissionTime = req.headers.get('paypal-transmission-time');
  const transmissionSig = req.headers.get('paypal-transmission-sig');
  const certUrl = req.headers.get('paypal-cert-url');
  const authAlgo = req.headers.get('paypal-auth-algo');

  if (!transmissionId || !transmissionTime || !transmissionSig) {
    return { verified: false, error: 'Missing PayPal signature headers' };
  }

  try {
    // Get OAuth token
    const authResponse = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!authResponse.ok) {
      console.error('❌ Failed to get PayPal OAuth token:', await authResponse.text());
      return { verified: false, error: 'OAuth token failed' };
    }

    const authData = await authResponse.json();
    const accessToken = authData.access_token;

    // Verify webhook signature using PayPal's official verify endpoint
    const verifyResponse = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: JSON.parse(body),
      }),
    });

    if (!verifyResponse.ok) {
      console.error('❌ PayPal signature verification request failed:', await verifyResponse.text());
      return { verified: false, error: 'Verification request failed' };
    }

    const verifyData = await verifyResponse.json();
    const isVerified = verifyData.verification_status === 'SUCCESS';
    
    if (isVerified) {
      console.log('✅ signature_verified=true (PayPal)');
    } else {
      console.error('❌ PayPal signature verification failed:', verifyData);
    }
    
    return { verified: isVerified };
  } catch (error) {
    console.error('❌ PayPal verification error:', error);
    return { verified: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function mapPayPalStatus(eventType: string): string {
  if (eventType.includes('COMPLETED') || eventType.includes('APPROVED') || eventType.includes('CAPTURED')) {
    return 'paid';
  }
  if (eventType.includes('DENIED') || eventType.includes('FAILED') || eventType.includes('DECLINED') || 
      eventType.includes('CANCELLED') || eventType.includes('REFUNDED') || eventType.includes('REVERSED')) {
    return 'failed';
  }
  if (eventType.includes('PENDING')) {
    return 'pending';
  }
  if (eventType.includes('CREATED') || eventType.includes('ACTIVATED')) {
    return 'active';
  }
  if (eventType.includes('SUSPENDED') || eventType.includes('EXPIRED') || eventType.includes('CANCELLED')) {
    return 'canceled';
  }
  return 'unknown';
}

function extractAmount(resource: Record<string, unknown>): number {
  const amount = resource.amount as Record<string, unknown> | undefined;
  if (amount?.total) return Math.round(parseFloat(amount.total as string) * 100);
  if (amount?.value) return Math.round(parseFloat(amount.value as string) * 100);
  
  const purchaseUnits = resource.purchase_units as Array<Record<string, unknown>> | undefined;
  if (purchaseUnits?.[0]?.amount) {
    const puAmount = purchaseUnits[0].amount as Record<string, unknown>;
    if (puAmount.value) return Math.round(parseFloat(puAmount.value as string) * 100);
  }

  const grossAmount = resource.gross_amount as Record<string, unknown> | undefined;
  if (grossAmount?.value) return Math.round(parseFloat(grossAmount.value as string) * 100);

  const billingInfo = resource.billing_info as Record<string, unknown> | undefined;
  if (billingInfo?.last_payment) {
    const lastPayment = billingInfo.last_payment as Record<string, unknown>;
    const lpAmount = lastPayment.amount as Record<string, unknown>;
    if (lpAmount?.value) return Math.round(parseFloat(lpAmount.value as string) * 100);
  }

  return 0;
}

function extractCurrency(resource: Record<string, unknown>): string {
  const amount = resource.amount as Record<string, unknown> | undefined;
  if (amount?.currency_code) return amount.currency_code as string;
  if (amount?.currency) return amount.currency as string;
  
  const purchaseUnits = resource.purchase_units as Array<Record<string, unknown>> | undefined;
  if (purchaseUnits?.[0]?.amount) {
    const puAmount = purchaseUnits[0].amount as Record<string, unknown>;
    if (puAmount.currency_code) return puAmount.currency_code as string;
  }

  return 'USD';
}

function extractEmail(resource: Record<string, unknown>): string | null {
  const payer = resource.payer as Record<string, unknown> | undefined;
  if (payer?.email_address) return payer.email_address as string;
  if (payer?.payer_info) {
    const payerInfo = payer.payer_info as Record<string, unknown>;
    if (payerInfo.email) return payerInfo.email as string;
  }

  const subscriber = resource.subscriber as Record<string, unknown> | undefined;
  if (subscriber?.email_address) return subscriber.email_address as string;

  const buyer = resource.buyer as Record<string, unknown> | undefined;
  if (buyer?.email_address) return buyer.email_address as string;

  if (resource.email_address) return resource.email_address as string;
  if (resource.email) return resource.email as string;

  return null;
}

function extractName(resource: Record<string, unknown>): string | null {
  const payer = resource.payer as Record<string, unknown> | undefined;
  if (payer?.name) {
    const name = payer.name as Record<string, unknown>;
    return `${name.given_name || ''} ${name.surname || ''}`.trim() || null;
  }

  const subscriber = resource.subscriber as Record<string, unknown> | undefined;
  if (subscriber?.name) {
    const name = subscriber.name as Record<string, unknown>;
    return `${name.given_name || ''} ${name.surname || ''}`.trim() || null;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const webhookId = Deno.env.get('PAYPAL_WEBHOOK_ID');
    const clientId = Deno.env.get('PAYPAL_CLIENT_ID');
    const clientSecret = Deno.env.get('PAYPAL_SECRET');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Missing required environment variables');
      return new Response(
        JSON.stringify({ error: 'Server configuration error', code: 'MISSING_ENV' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // SECURITY: REQUIRE webhook configuration - reject if not configured
    if (!webhookId || !clientId || !clientSecret) {
      console.error('❌ PayPal webhook not fully configured - webhook disabled for security');
      return new Response(
        JSON.stringify({ 
          error: 'Webhook not configured', 
          code: 'MISSING_WEBHOOK_CONFIG',
          message: 'PAYPAL_WEBHOOK_ID, PAYPAL_CLIENT_ID, and PAYPAL_SECRET must all be configured'
        }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.text();

    // SECURITY: Verify PayPal signature (REQUIRED)
    const verification = await verifyPayPalWebhook(req, body);
    if (!verification.verified) {
      console.error('❌ PayPal signature verification failed:', verification.error);
      return new Response(
        JSON.stringify({ error: 'Invalid signature', code: 'INVALID_SIGNATURE', details: verification.error }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const event: PayPalEvent = JSON.parse(body);
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // IDEMPOTENCY: Check webhook_events table for duplicate
    const { data: existingWebhookEvent } = await supabase
      .from('webhook_events')
      .select('id')
      .eq('source', 'paypal')
      .eq('event_id', event.id)
      .maybeSingle();

    if (existingWebhookEvent) {
      console.log(`⏭️ Event ${event.id} already processed (idempotent skip)`);
      return new Response(
        JSON.stringify({ 
          received: true, 
          skipped: true, 
          reason: 'already_processed',
          signature_verified: true 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Record event in webhook_events for idempotency
    const { error: webhookEventError } = await supabase
      .from('webhook_events')
      .insert({
        source: 'paypal',
        event_id: event.id,
        event_type: event.event_type,
        payload: event.resource,
      });

    if (webhookEventError) {
      // If insert fails due to unique constraint, it's a race condition - treat as already processed
      if (webhookEventError.code === '23505') {
        console.log(`⏭️ Event ${event.id} race condition - already processed`);
        return new Response(
          JSON.stringify({ received: true, skipped: true, reason: 'race_condition' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      console.error('Error recording webhook event:', webhookEventError);
    }

    console.log(`🔔 PayPal Event: ${event.event_type}, ID: ${event.id}, signature_verified=true`);

    const resource = event.resource;
    const status = mapPayPalStatus(event.event_type);
    const email = extractEmail(resource);
    const amount = extractAmount(resource);
    const currency = extractCurrency(resource);
    const fullName = extractName(resource);
    
    let transactionId = resource.id as string;
    let paymentKey = transactionId;
    let fullTransactionId: string;
    
    if (!transactionId) {
      transactionId = event.id;
      paymentKey = event.id;
      fullTransactionId = `paypal_${event.id}`;
    } else {
      fullTransactionId = `paypal_${transactionId}`;
    }

    const createdAt = resource.create_time 
      ? new Date(resource.create_time as string).toISOString()
      : event.create_time 
        ? new Date(event.create_time).toISOString() 
        : new Date().toISOString();

    // Handle customer/subscription events
    if (event.event_type.includes('BILLING.SUBSCRIPTION') || event.event_type.includes('CUSTOMER')) {
      if (email) {
        const clientData: Record<string, unknown> = {
          email,
          full_name: fullName,
          last_sync: new Date().toISOString(),
        };

        if (event.event_type.includes('CREATED') || event.event_type.includes('ACTIVATED')) {
          clientData.status = 'active';
          if (event.event_type.includes('SUBSCRIPTION')) {
            clientData.trial_started_at = createdAt;
          }
        } else if (event.event_type.includes('CANCELLED') || event.event_type.includes('SUSPENDED') || event.event_type.includes('EXPIRED')) {
          clientData.status = 'churned';
        }

        const { error } = await supabase
          .from('clients')
          .upsert(clientData, { onConflict: 'email' });

        if (error) console.error('Error upserting client:', error);
        else console.log(`✅ PayPal Client ${event.event_type}: ${email}`);
      }
    }

    // Handle payment events
    if (event.event_type.includes('PAYMENT') || event.event_type.includes('CAPTURE') || 
        event.event_type.includes('SALE') || event.event_type.includes('ORDER')) {
      
      if (!email) {
        console.log(`⚠️ Skipping ${event.event_type}: no email`);
        return new Response(
          JSON.stringify({ received: true, skipped: true, reason: 'no_email', signature_verified: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      let failureCode: string | null = null;
      let failureMessage: string | null = null;
      
      if (status === 'failed') {
        failureCode = event.event_type;
        const statusDetail = resource.status_details as Record<string, unknown> | undefined;
        failureMessage = (statusDetail?.reason as string) || `Payment ${event.event_type}`;
      }

      const transactionData = {
        stripe_payment_intent_id: fullTransactionId,
        payment_key: paymentKey,
        external_transaction_id: paymentKey,
        amount,
        currency: currency.toLowerCase(),
        status,
        customer_email: email,
        stripe_created_at: createdAt,
        source: 'paypal',
        failure_code: failureCode,
        failure_message: failureMessage,
        metadata: { event_type: event.event_type, paypal_id: resource.id, webhook_event_id: event.id },
      };

      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactionData, { onConflict: 'source,payment_key' });

      if (txError) {
        console.error('Error upserting transaction:', txError);
        throw txError;
      }

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
            full_name: fullName,
            payment_status: 'paid',
            total_paid: (existingClient?.total_paid || 0) + (amount / 100),
            last_sync: new Date().toISOString(),
          }, { onConflict: 'email' });

        if (clientError) console.error('Error upserting client:', clientError);
      }

      console.log(`✅ PayPal ${event.event_type}: ${fullTransactionId} - ${status} - ${amount}¢ - ${email}`);

      return new Response(
        JSON.stringify({ 
          received: true, 
          processed: true,
          type: event.event_type,
          transaction_id: fullTransactionId,
          payment_key: paymentKey,
          status,
          amount,
          email,
          signature_verified: true
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`ℹ️ PayPal Event ${event.event_type} acknowledged`);
    return new Response(
      JSON.stringify({ received: true, processed: email ? true : false, type: event.event_type, signature_verified: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ PayPal Webhook error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
