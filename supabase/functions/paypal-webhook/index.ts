import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, paypal-transmission-id, paypal-transmission-time, paypal-transmission-sig, paypal-cert-url, paypal-auth-algo',
};

interface PayPalEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
  create_time: string;
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
  // Try different amount locations - PayPal sends DOLLARS, multiply by 100 for CENTS
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

  // For subscriptions
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
  // Direct payer info
  const payer = resource.payer as Record<string, unknown> | undefined;
  if (payer?.email_address) return payer.email_address as string;
  if (payer?.payer_info) {
    const payerInfo = payer.payer_info as Record<string, unknown>;
    if (payerInfo.email) return payerInfo.email as string;
  }

  // Subscriber info (for subscriptions)
  const subscriber = resource.subscriber as Record<string, unknown> | undefined;
  if (subscriber?.email_address) return subscriber.email_address as string;

  // Buyer info
  const buyer = resource.buyer as Record<string, unknown> | undefined;
  if (buyer?.email_address) return buyer.email_address as string;

  // Direct email field
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

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing required environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.text();
    const event: PayPalEvent = JSON.parse(body);

    console.log(`🔔 PayPal Event: ${event.event_type}, ID: ${event.id}`);

    const resource = event.resource;
    const status = mapPayPalStatus(event.event_type);
    const email = extractEmail(resource);
    const amount = extractAmount(resource);
    const currency = extractCurrency(resource);
    const fullName = extractName(resource);
    
    // Get transaction ID
    let transactionId = resource.id as string;
    if (!transactionId) {
      transactionId = `paypal_${event.id}`;
    } else {
      transactionId = `paypal_${transactionId}`;
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
          JSON.stringify({ received: true, skipped: true, reason: 'no_email' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Determine failure info
      let failureCode: string | null = null;
      let failureMessage: string | null = null;
      
      if (status === 'failed') {
        failureCode = event.event_type;
        const statusDetail = resource.status_details as Record<string, unknown> | undefined;
        failureMessage = (statusDetail?.reason as string) || `Payment ${event.event_type}`;
      }

      const transactionData = {
        stripe_payment_intent_id: transactionId,
        amount,
        currency: currency.toUpperCase(),
        status,
        customer_email: email,
        stripe_created_at: createdAt,
        source: 'paypal',
        failure_code: failureCode,
        failure_message: failureMessage,
        metadata: { event_type: event.event_type, paypal_id: resource.id },
      };

      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactionData, { onConflict: 'stripe_payment_intent_id' });

      if (txError) {
        console.error('Error upserting transaction:', txError);
        throw txError;
      }

      // Update client - amount is already in cents, convert to dollars for total_paid display field
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
            total_paid: (existingClient?.total_paid || 0) + (amount / 100), // Convert cents to dollars for display
            last_sync: new Date().toISOString(),
          }, { onConflict: 'email' });

        if (clientError) console.error('Error upserting client:', clientError);
      }

      console.log(`✅ PayPal ${event.event_type}: ${transactionId} - ${status} - $${amount} - ${email}`);

      return new Response(
        JSON.stringify({ 
          received: true, 
          processed: true,
          type: event.event_type,
          transaction_id: transactionId,
          status,
          amount,
          email
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`ℹ️ PayPal Event ${event.event_type} acknowledged`);
    return new Response(
      JSON.stringify({ received: true, processed: email ? true : false, type: event.event_type }),
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
