import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// SECURITY: Simple admin key guard
function verifyAdminKey(req: Request): { valid: boolean; error?: string } {
  const adminKey = Deno.env.get("ADMIN_API_KEY");
  const providedKey = req.headers.get("x-admin-key");
  
  console.log(`🔐 Admin key check - Configured: ${adminKey ? 'YES (' + adminKey.substring(0, 10) + '...)' : 'NO'}, Provided: ${providedKey ? 'YES (' + providedKey.substring(0, 10) + '...)' : 'NO'}`);
  
  if (!adminKey) {
    return { valid: false, error: "ADMIN_API_KEY not configured on server" };
  }
  if (!providedKey) {
    return { valid: false, error: "x-admin-key header not provided" };
  }
  if (providedKey !== adminKey) {
    return { valid: false, error: "x-admin-key does not match" };
  }
  return { valid: true };
}

// Mapeo de decline codes a español
const DECLINE_REASONS_ES: Record<string, string> = {
  'insufficient_funds': 'Fondos insuficientes',
  'lost_card': 'Tarjeta perdida',
  'stolen_card': 'Tarjeta robada',
  'expired_card': 'Tarjeta expirada',
  'incorrect_cvc': 'CVC incorrecto',
  'processing_error': 'Error de procesamiento',
  'incorrect_number': 'Número incorrecto',
  'card_velocity_exceeded': 'Límite de transacciones excedido',
  'do_not_honor': 'Transacción rechazada por el banco',
  'generic_decline': 'Rechazo genérico',
  'card_declined': 'Tarjeta rechazada',
  'fraudulent': 'Transacción sospechosa',
  'blocked': 'Tarjeta bloqueada',
  'withdrawal_count_limit_exceeded': 'Límite de retiros excedido',
  'invalid_account': 'Cuenta inválida',
  'new_account_information_available': 'Datos de cuenta nuevos disponibles',
  'try_again_later': 'Intentar más tarde',
  'not_permitted': 'Transacción no permitida',
  'revocation_of_all_authorizations': 'Revocación de autorizaciones',
  'revocation_of_authorization': 'Autorización revocada',
  'stop_payment_order': 'Orden de detener pago',
  'call_issuer': 'Contactar al banco emisor',
  'currency_not_supported': 'Moneda no soportada',
  'duplicate_transaction': 'Transacción duplicada',
  'reenter_transaction': 'Reingresar transacción',
  'merchant_blacklist': 'Comercio en lista negra',
  'security_violation': 'Violación de seguridad',
  'service_not_allowed': 'Servicio no permitido',
  'testmode_decline': 'Rechazo en modo prueba',
  'transaction_not_allowed': 'Transacción no permitida',
};

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
}

interface StripeCharge {
  id: string;
  payment_method_details?: {
    card?: {
      brand?: string;
      last4?: string;
      exp_month?: number;
      exp_year?: number;
    };
  };
  outcome?: {
    network_status?: string;
    reason?: string;
    seller_message?: string;
    type?: string;
  };
  failure_code?: string;
  failure_message?: string;
}

interface StripeInvoice {
  id: string;
  number: string | null;
  subscription?: string | null;
  lines?: {
    data: Array<{
      description?: string;
      price?: {
        product?: string | {
          id: string;
          name: string;
        };
      };
    }>;
  };
}

interface StripePaymentIntent {
  id: string;
  customer: string | StripeCustomer | null;
  amount: number;
  currency: string;
  status: string;
  last_payment_error?: {
    code?: string;
    message?: string;
    decline_code?: string;
  } | null;
  created: number;
  metadata: Record<string, string>;
  receipt_email?: string | null;
  latest_charge?: string | StripeCharge | null;
  invoice?: string | StripeInvoice | null;
  description?: string | null;
}

interface StripeListResponse {
  data: StripePaymentIntent[];
  has_more: boolean;
}

const customerEmailCache = new Map<string, { email: string | null; name: string | null; phone: string | null }>();

async function getCustomerInfo(customerId: string, stripeSecretKey: string): Promise<{ email: string | null; name: string | null; phone: string | null }> {
  if (customerEmailCache.has(customerId)) {
    return customerEmailCache.get(customerId)!;
  }

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/customers/${customerId}`,
      {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
        },
      }
    );

    if (!response.ok) {
      customerEmailCache.set(customerId, { email: null, name: null, phone: null });
      return { email: null, name: null, phone: null };
    }

    const customer: StripeCustomer = await response.json();
    const info = { email: customer.email || null, name: customer.name || null, phone: customer.phone || null };
    customerEmailCache.set(customerId, info);
    return info;
  } catch {
    customerEmailCache.set(customerId, { email: null, name: null, phone: null });
    return { email: null, name: null, phone: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // SECURITY: Verify x-admin-key
    const authCheck = verifyAdminKey(req);
    if (!authCheck.valid) {
      console.error("❌ Auth failed:", authCheck.error);
      return new Response(
        JSON.stringify({ error: "Forbidden", message: authCheck.error }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Admin key verified");

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let fetchAll = false;
    let startDate: number | null = null;
    let endDate: number | null = null;
    
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate) {
        startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      }
      if (body.endDate) {
        endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
      }
    } catch {
      // No body
    }

    console.log(`🔄 Stripe Sync - fetchAll: ${fetchAll}, startDate: ${startDate}, endDate: ${endDate}`);

    // Create sync_run record
    const { data: syncRun } = await supabase
      .from('sync_runs')
      .insert({
        source: 'stripe',
        status: 'running',
        metadata: { fetchAll, startDate, endDate }
      })
      .select('id')
      .single();
    
    const syncRunId = syncRun?.id;

    let totalSynced = 0;
    let totalClients = 0;
    let paidCount = 0;
    let failedCount = 0;
    let skippedNoEmail = 0;
    let hasMore = true;
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = fetchAll ? 50 : 1;

    while (hasMore && pageCount < maxPages) {
      const url = new URL("https://api.stripe.com/v1/payment_intents");
      url.searchParams.set("limit", "100");
      // Expand customer, latest_charge, and invoice for enriched data
      url.searchParams.append("expand[]", "data.customer");
      url.searchParams.append("expand[]", "data.latest_charge");
      url.searchParams.append("expand[]", "data.invoice");
      
      if (startDate) {
        url.searchParams.set("created[gte]", startDate.toString());
      }
      if (endDate) {
        url.searchParams.set("created[lte]", endDate.toString());
      }
      
      if (cursor) {
        url.searchParams.set("starting_after", cursor);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Stripe API error:", errorText);
        break;
      }

      const data: StripeListResponse = await response.json();
      
      if (data.data.length === 0) break;

      const transactions: Array<Record<string, unknown>> = [];
      const clientsMap = new Map<string, Record<string, unknown>>();

      for (const pi of data.data) {
        let email = pi.receipt_email || null;
        let customerName: string | null = null;
        let customerPhone: string | null = null;
        let customerId: string | null = null;

        if (pi.customer) {
          if (typeof pi.customer === 'object' && pi.customer !== null) {
            email = email || pi.customer.email || null;
            customerName = pi.customer.name || null;
            customerPhone = pi.customer.phone || null;
            customerId = pi.customer.id;
          } else if (typeof pi.customer === 'string') {
            customerId = pi.customer;
            const info = await getCustomerInfo(pi.customer, stripeSecretKey);
            email = email || info.email;
            customerName = info.name;
            customerPhone = info.phone;
          }
        }

        if (!email) {
          skippedNoEmail++;
          continue;
        }

        // Extract card info from latest_charge
        let cardLast4: string | null = null;
        let cardBrand: string | null = null;
        let chargeFailureCode: string | null = null;
        let chargeFailureMessage: string | null = null;
        let chargeOutcomeReason: string | null = null;

        if (pi.latest_charge && typeof pi.latest_charge === 'object') {
          const charge = pi.latest_charge as StripeCharge;
          cardLast4 = charge.payment_method_details?.card?.last4 || null;
          cardBrand = charge.payment_method_details?.card?.brand || null;
          chargeFailureCode = charge.failure_code || null;
          chargeFailureMessage = charge.failure_message || null;
          chargeOutcomeReason = charge.outcome?.reason || null;
        }

        // Extract product/invoice info
        let productName: string | null = null;
        let invoiceNumber: string | null = null;
        let subscriptionId: string | null = null;

        if (pi.invoice && typeof pi.invoice === 'object') {
          const invoice = pi.invoice as StripeInvoice;
          invoiceNumber = invoice.number || null;
          subscriptionId = invoice.subscription || null;

          // Get product name from invoice lines
          if (invoice.lines?.data?.[0]) {
            const firstLine = invoice.lines.data[0];
            productName = firstLine.description || null;
            if (!productName && firstLine.price?.product) {
              if (typeof firstLine.price.product === 'object') {
                productName = firstLine.price.product.name || null;
              }
            }
          }
        }

        // Fallback to description if no product name
        if (!productName && pi.description) {
          productName = pi.description;
        }

        // Determine status and failure reason
        let mappedStatus: string;
        let failureCode = pi.last_payment_error?.code || pi.last_payment_error?.decline_code || chargeFailureCode || null;
        let failureMessage = pi.last_payment_error?.message || chargeFailureMessage || null;
        let declineReasonEs: string | null = null;

        if (pi.status === "succeeded") {
          mappedStatus = "paid";
          paidCount++;
        } else {
          mappedStatus = "failed";
          failedCount++;
          
          // Use outcome reason or decline code for Spanish translation
          const codeForTranslation = chargeOutcomeReason || pi.last_payment_error?.decline_code || failureCode;
          if (codeForTranslation) {
            declineReasonEs = DECLINE_REASONS_ES[codeForTranslation] || codeForTranslation;
          }
          
          if (!failureCode && pi.status) {
            failureCode = pi.status;
          }
        }

        // Build enriched metadata
        const enrichedMetadata = {
          ...pi.metadata,
          customer_name: customerName,
          customer_phone: customerPhone,
          card_last4: cardLast4,
          card_brand: cardBrand,
          product_name: productName,
          invoice_number: invoiceNumber,
          decline_reason_es: declineReasonEs,
          outcome_reason: chargeOutcomeReason,
        };

        // Remove null values from metadata
        Object.keys(enrichedMetadata).forEach(key => {
          if (enrichedMetadata[key as keyof typeof enrichedMetadata] === null) {
            delete enrichedMetadata[key as keyof typeof enrichedMetadata];
          }
        });

        transactions.push({
          stripe_payment_intent_id: pi.id,
          payment_key: pi.id,
          stripe_customer_id: customerId,
          customer_email: email,
          amount: pi.amount,
          currency: pi.currency.toLowerCase(),
          status: mappedStatus,
          failure_code: failureCode,
          failure_message: failureMessage,
          stripe_created_at: new Date(pi.created * 1000).toISOString(),
          metadata: enrichedMetadata,
          source: "stripe",
          subscription_id: subscriptionId,
        });

        // Build client data with enriched info
        const existing = clientsMap.get(email) || { 
          email, 
          payment_status: 'none', 
          total_paid: 0,
          status: 'active',
          last_sync: new Date().toISOString(),
          full_name: null,
          phone: null,
          stripe_customer_id: null,
        };
        
        if (mappedStatus === 'paid') {
          existing.payment_status = 'paid';
          existing.total_paid = (existing.total_paid as number) + (pi.amount / 100);
        } else if (existing.payment_status !== 'paid') {
          existing.payment_status = 'failed';
        }

        // Update client with enriched data (only if not already set)
        if (customerName && !existing.full_name) {
          existing.full_name = customerName;
        }
        if (customerPhone && !existing.phone) {
          existing.phone = customerPhone;
        }
        if (customerId && !existing.stripe_customer_id) {
          existing.stripe_customer_id = customerId;
        }

        clientsMap.set(email, existing);
      }

      if (transactions.length > 0) {
        const { error: txError, data: txData } = await supabase
          .from("transactions")
          .upsert(transactions, { onConflict: "source,payment_key", ignoreDuplicates: false })
          .select("id");

        if (txError) {
          console.error(`Page ${pageCount + 1} tx error:`, txError.message);
        } else {
          totalSynced += txData?.length || 0;
        }
      }

      const clientsToSave = Array.from(clientsMap.values());
      if (clientsToSave.length > 0) {
        const { error: clientError, data: clientData } = await supabase
          .from("clients")
          .upsert(clientsToSave, { onConflict: "email", ignoreDuplicates: false })
          .select("id");

        if (!clientError) {
          totalClients += clientData?.length || 0;
        }
      }

      hasMore = data.has_more && fetchAll;
      cursor = data.data[data.data.length - 1].id;
      pageCount++;
      
      console.log(`📄 Page ${pageCount}: saved ${transactions.length} tx (total: ${totalSynced})`);
    }

    // Update sync_run record
    if (syncRunId) {
      await supabase
        .from('sync_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          total_fetched: totalSynced + skippedNoEmail,
          total_inserted: totalSynced,
          total_skipped: skippedNoEmail,
          metadata: { fetchAll, startDate, endDate, paidCount, failedCount, pages: pageCount }
        })
        .eq('id', syncRunId);
    }

    console.log(`✅ Done: ${totalSynced} transactions, ${totalClients} clients`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${totalSynced} transactions`,
        synced_transactions: totalSynced,
        synced_clients: totalClients,
        paid_count: paidCount,
        failed_count: failedCount,
        skipped_no_email: skippedNoEmail,
        pages_fetched: pageCount,
        has_more: hasMore,
        sync_run_id: syncRunId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
