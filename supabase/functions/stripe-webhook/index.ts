import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!stripeSecretKey || !supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing required environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const body = await req.text();
    const event: StripeEvent = JSON.parse(body);

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
      // CRITICAL FIX: Stripe sends amount in CENTS - store directly WITHOUT dividing
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
      // CRITICAL FIX: Stripe sends amount in CENTS - store directly
      amount = obj.amount as number;
      status = mapStripeStatus(obj.status as string);
      email = obj.receipt_email as string | null;
      customerId = obj.customer as string | null;
      createdAt = new Date((obj.created as number) * 1000).toISOString();
      
      const outcome = obj.outcome as Record<string, unknown> | null;
      if (obj.failure_code) failureCode = obj.failure_code as string;
      if (obj.failure_message) failureMessage = obj.failure_message as string;
      if (outcome?.risk_level === 'elevated') failureCode = 'high_risk';
      processed = true;
    }
    
    // INVOICE EVENTS
    else if (event.type.startsWith('invoice.')) {
      paymentIntentId = (obj.payment_intent as string) || `invoice_${obj.id}`;
      // CRITICAL FIX: Stripe sends amount in CENTS - store directly
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
      // CRITICAL FIX: Stripe sends unit_amount in CENTS - store directly
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
    else if (event.type.startsWith('customer.')) {
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
      // CRITICAL FIX: Stripe sends amount_total in CENTS - store directly
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

      // NORMALIZED: payment_key = payment_intent_id for perfect dedup
      const transactionData = {
        stripe_payment_intent_id: paymentIntentId,
        payment_key: paymentIntentId, // CANONICAL dedup key
        amount,
        currency: ((obj.currency as string) || 'usd').toLowerCase(), // Normalize to lowercase
        status,
        customer_email: email,
        stripe_customer_id: customerId,
        stripe_created_at: createdAt,
        source: 'stripe',
        failure_code: failureCode,
        failure_message: failureMessage,
        metadata: obj.metadata || null,
      };

      // Use new UNIQUE constraint: (source, payment_key)
      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactionData, { onConflict: 'source,payment_key' });

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
            payment_status: 'paid',
            total_paid: (existingClient?.total_paid || 0) + (amount / 100), // Convert cents to dollars for display
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

      console.log(`✅ ${event.type}: ${paymentIntentId} - ${status} - $${amount} - ${email}`);

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
