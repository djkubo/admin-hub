import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount: number;
      currency: string;
      status: string;
      receipt_email?: string;
      customer?: string;
      created: number;
      last_payment_error?: {
        code?: string;
        message?: string;
      };
      metadata?: Record<string, string>;
    };
  };
}

async function getCustomerEmail(customerId: string, stripeSecretKey: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
      },
    });
    
    if (!response.ok) {
      console.error('Failed to fetch customer:', response.status);
      return null;
    }
    
    const customer = await response.json();
    return customer.email || null;
  } catch (error) {
    console.error('Error fetching customer email:', error);
    return null;
  }
}

function mapStripeStatus(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'paid';
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_confirmation':
    case 'canceled':
    case 'processing':
      return 'failed';
    default:
      return status;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
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

    // Get the raw body for signature verification (optional, can add later)
    const body = await req.text();
    const event: StripeEvent = JSON.parse(body);

    console.log(`Received Stripe event: ${event.type}, ID: ${event.id}`);

    // Handle payment intent events
    if (event.type === 'payment_intent.succeeded' || 
        event.type === 'payment_intent.payment_failed' ||
        event.type === 'payment_intent.canceled' ||
        event.type === 'payment_intent.requires_action') {
      
      const paymentIntent = event.data.object;
      
      // Get customer email
      let email = paymentIntent.receipt_email;
      
      if (!email && paymentIntent.customer) {
        const customerEmail = await getCustomerEmail(paymentIntent.customer, stripeSecretKey);
        if (customerEmail) {
          email = customerEmail;
        }
      }

      if (!email) {
        console.log(`Skipping payment ${paymentIntent.id}: no email available`);
        return new Response(
          JSON.stringify({ received: true, skipped: true, reason: 'no_email' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const mappedStatus = mapStripeStatus(paymentIntent.status);
      const isFailure = mappedStatus === 'failed';

      const transactionData = {
        stripe_payment_intent_id: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency?.toUpperCase() || 'USD',
        status: mappedStatus,
        customer_email: email,
        stripe_customer_id: paymentIntent.customer || null,
        stripe_created_at: new Date(paymentIntent.created * 1000).toISOString(),
        source: 'stripe',
        failure_code: isFailure ? (paymentIntent.last_payment_error?.code || paymentIntent.status) : null,
        failure_message: isFailure ? (paymentIntent.last_payment_error?.message || `Payment ${paymentIntent.status}`) : null,
        metadata: paymentIntent.metadata || null,
      };

      console.log(`Processing payment: ${paymentIntent.id}, status: ${mappedStatus}, email: ${email}`);

      // Upsert transaction
      const { error: txError } = await supabase
        .from('transactions')
        .upsert(transactionData, { onConflict: 'stripe_payment_intent_id' });

      if (txError) {
        console.error('Error upserting transaction:', txError);
        throw txError;
      }

      // Update client record if payment succeeded
      if (mappedStatus === 'paid') {
        // Get current client data
        const { data: existingClient } = await supabase
          .from('clients')
          .select('total_paid')
          .eq('email', email)
          .single();

        const currentTotal = existingClient?.total_paid || 0;

        const { error: clientError } = await supabase
          .from('clients')
          .upsert({
            email: email,
            payment_status: 'paid',
            total_paid: currentTotal + (paymentIntent.amount / 100),
            last_sync: new Date().toISOString(),
          }, { onConflict: 'email' });

        if (clientError) {
          console.error('Error upserting client:', clientError);
        }
      }

      console.log(`Successfully processed payment: ${paymentIntent.id}`);

      return new Response(
        JSON.stringify({ 
          received: true, 
          processed: true,
          payment_intent: paymentIntent.id,
          status: mappedStatus
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For other event types, just acknowledge
    console.log(`Event type ${event.type} not processed`);
    return new Response(
      JSON.stringify({ received: true, processed: false }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Webhook error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
