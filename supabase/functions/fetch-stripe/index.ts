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
  
  console.log(`🔐 Admin key check - Configured: ${adminKey ? 'YES' : 'NO'}, Provided: ${providedKey ? 'YES' : 'NO'}`);
  
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

// INCREASED: Process more pages per invocation (Deno limit ~5 mins, but we can do more)
const MAX_PAGES_PER_INVOCATION = 15;

// Background worker that continues processing
async function continueSync(
  supabaseUrl: string,
  adminKey: string,
  continuationBody: Record<string, unknown>
) {
  try {
    console.log(`🔄 Background: Starting continuation...`);
    const response = await fetch(`${supabaseUrl}/functions/v1/fetch-stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: JSON.stringify(continuationBody)
    });
    console.log(`🔄 Background: Continuation response status: ${response.status}`);
  } catch (err) {
    console.error('🔄 Background: Continuation error:', err);
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
    const adminKey = Deno.env.get("ADMIN_API_KEY");
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
    let requestedMaxPages = 50;
    let continuationCursor: string | null = null;
    let continuationSyncRunId: string | null = null;
    let continuationPageCount = 0;
    let continuationTotalSynced = 0;
    let continuationTotalClients = 0;
    
    try {
      const body = await req.json();
      fetchAll = body.fetchAll === true;
      
      if (body.startDate) {
        startDate = Math.floor(new Date(body.startDate).getTime() / 1000);
      }
      if (body.endDate) {
        endDate = Math.floor(new Date(body.endDate).getTime() / 1000);
      }
      if (typeof body.maxPages === 'number' && body.maxPages > 0) {
        requestedMaxPages = Math.min(body.maxPages, 2000); // Allow more pages for 3yr sync
      }
      // Continuation params from auto-continue
      if (body._continuation) {
        continuationCursor = body._continuation.cursor || null;
        continuationSyncRunId = body._continuation.syncRunId || null;
        continuationPageCount = body._continuation.pageCount || 0;
        continuationTotalSynced = body._continuation.totalSynced || 0;
        continuationTotalClients = body._continuation.totalClients || 0;
        console.log(`🔄 CONTINUATION from page ${continuationPageCount}, cursor: ${continuationCursor?.substring(0, 20)}...`);
      }
    } catch {
      // No body
    }

    console.log(`🔄 Stripe Sync - fetchAll: ${fetchAll}, maxPages: ${requestedMaxPages}, continuation: ${!!continuationCursor}`);

    // Create or reuse sync_run record
    let syncRunId = continuationSyncRunId;
    if (!syncRunId) {
      const { data: syncRun } = await supabase
        .from('sync_runs')
        .insert({
          source: 'stripe',
          status: 'running',
          metadata: { fetchAll, startDate, endDate, requestedMaxPages }
        })
        .select('id')
        .single();
      syncRunId = syncRun?.id;
    }

    // Process sync
    let totalSynced = continuationTotalSynced;
    let totalClients = continuationTotalClients;
    let paidCount = 0;
    let failedCount = 0;
    let skippedNoEmail = 0;
    let hasMore = true;
    let cursor: string | null = continuationCursor;
    let pageCount = continuationPageCount;
    const maxPages = fetchAll ? requestedMaxPages : 1;
    const maxPagesThisInvocation = Math.min(MAX_PAGES_PER_INVOCATION, maxPages - pageCount);
    let pagesThisInvocation = 0;

    while (hasMore && pagesThisInvocation < maxPagesThisInvocation && pageCount < maxPages) {
      const url = new URL("https://api.stripe.com/v1/payment_intents");
      url.searchParams.set("limit", "100");
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
        
        // Mark sync as failed
        if (syncRunId) {
          await supabase
            .from('sync_runs')
            .update({
              status: 'failed',
              completed_at: new Date().toISOString(),
              error_message: `Stripe API error: ${response.status}`,
              total_fetched: totalSynced + skippedNoEmail,
              total_inserted: totalSynced
            })
            .eq('id', syncRunId);
        }
        
        return new Response(
          JSON.stringify({ error: "Stripe API error", details: errorText }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
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

        if (!productName && pi.description) {
          productName = pi.description;
        }

        // Determine status and failure reason
        let mappedStatus: string;
        let failureCode = pi.last_payment_error?.code || pi.last_payment_error?.decline_code || chargeFailureCode || null;
        let failureMessage = pi.last_payment_error?.message || chargeFailureMessage || null;
        let declineReasonEs: string | null = null;

        switch (pi.status) {
          case "succeeded":
            mappedStatus = "succeeded";
            paidCount++;
            break;
          case "requires_payment_method":
            mappedStatus = "requires_payment_method";
            failedCount++;
            if (failureCode && DECLINE_REASONS_ES[failureCode]) {
              declineReasonEs = DECLINE_REASONS_ES[failureCode];
            } else if (chargeOutcomeReason && DECLINE_REASONS_ES[chargeOutcomeReason]) {
              declineReasonEs = DECLINE_REASONS_ES[chargeOutcomeReason];
            } else {
              declineReasonEs = "Pago rechazado";
            }
            break;
          case "requires_action":
          case "requires_confirmation":
          case "processing":
            mappedStatus = "pending";
            break;
          case "canceled":
            mappedStatus = "canceled";
            break;
          default:
            mappedStatus = "failed";
            failedCount++;
        }

        // Build enriched metadata
        const metadata: Record<string, unknown> = {
          ...(pi.metadata || {}),
          card_last4: cardLast4,
          card_brand: cardBrand,
          product_name: productName,
          invoice_number: invoiceNumber,
          decline_reason_es: declineReasonEs,
          customer_name: customerName,
        };

        transactions.push({
          stripe_payment_intent_id: pi.id,
          external_transaction_id: pi.id,
          amount: pi.amount,
          currency: pi.currency?.toLowerCase() || "usd",
          status: mappedStatus,
          customer_email: email.toLowerCase(),
          stripe_customer_id: customerId,
          stripe_created_at: new Date(pi.created * 1000).toISOString(),
          source: "stripe",
          subscription_id: subscriptionId,
          failure_code: failureCode,
          failure_message: failureMessage,
          payment_type: "unknown",
          metadata,
        });

        if (email) {
          const emailLower = email.toLowerCase();
          if (!clientsMap.has(emailLower)) {
            clientsMap.set(emailLower, {
              email: emailLower,
              full_name: customerName || null,
              phone: customerPhone || null,
              stripe_customer_id: customerId,
              lifecycle_stage: mappedStatus === "succeeded" ? "CUSTOMER" : "LEAD",
              last_sync: new Date().toISOString(),
            });
          }
        }
      }

      // Save transactions
      if (transactions.length > 0) {
        const { error: txError, data: txData } = await supabase
          .from("transactions")
          .upsert(transactions, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: false })
          .select("id");

        if (txError) {
          console.error(`Page ${pageCount + 1} tx error:`, txError.message);
        } else {
          totalSynced += txData?.length || 0;
        }
      }

      // Save clients
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
      pagesThisInvocation++;
      
      console.log(`📄 Page ${pageCount}: saved ${transactions.length} tx (total: ${totalSynced})`);

      // Update checkpoint every page
      if (syncRunId) {
        await supabase
          .from('sync_runs')
          .update({
            total_fetched: totalSynced + skippedNoEmail,
            total_inserted: totalSynced,
            checkpoint: { last_cursor: cursor, page: pageCount }
          })
          .eq('id', syncRunId);
      }
    }

    // Check if we need to auto-continue
    const needsContinuation = hasMore && pageCount < maxPages;

    if (needsContinuation && syncRunId && adminKey) {
      console.log(`🔄 Auto-continuing: ${pageCount}/${maxPages} pages done, scheduling next batch...`);
      
      const continuationBody = {
        fetchAll,
        startDate: startDate ? new Date(startDate * 1000).toISOString() : undefined,
        endDate: endDate ? new Date(endDate * 1000).toISOString() : undefined,
        maxPages: requestedMaxPages,
        _continuation: {
          cursor,
          syncRunId,
          pageCount,
          totalSynced,
          totalClients
        }
      };

      // Use EdgeRuntime.waitUntil for reliable background continuation
      // @ts-ignore - EdgeRuntime is available in Deno Deploy
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
        console.log(`🔄 Using EdgeRuntime.waitUntil for continuation`);
        // @ts-ignore
        EdgeRuntime.waitUntil(continueSync(supabaseUrl, adminKey, continuationBody));
      } else {
        // Fallback: direct fetch (less reliable but works)
        console.log(`🔄 Using direct fetch for continuation (fallback)`);
        fetch(`${supabaseUrl}/functions/v1/fetch-stripe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': adminKey,
          },
          body: JSON.stringify(continuationBody)
        }).catch(err => console.error('Continuation error:', err));
      }

      return new Response(
        JSON.stringify({
          status: 'continuing',
          message: `Processed ${pagesThisInvocation} pages (${totalSynced} total). Continuing in background...`,
          syncRunId,
          pagesCompleted: pageCount,
          totalSynced,
        }),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark completed
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

    console.log(`✅ COMPLETE: ${totalSynced} transactions, ${totalClients} clients, ${pageCount} pages`);

    return new Response(
      JSON.stringify({
        success: true,
        synced_transactions: totalSynced,
        synced_clients: totalClients,
        pages: pageCount,
        paidCount,
        failedCount,
        skippedNoEmail,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
