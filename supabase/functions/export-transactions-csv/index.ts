import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ExportParams {
  startDate?: string;
  endDate?: string;
  source?: string;
  status?: string;
  search?: string;
  includeDisputes?: boolean;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const params: ExportParams = await req.json();
    const { startDate, endDate, source, status, search, includeDisputes } = params;

    console.log("📊 Export request:", params);

    // Build transactions query
    let query = supabase
      .from("transactions")
      .select("stripe_payment_intent_id, stripe_created_at, amount, currency, status, customer_email, source, external_transaction_id, failure_code, failure_message, metadata, payment_type")
      .order("stripe_created_at", { ascending: false });

    // Apply filters
    if (startDate) {
      query = query.gte("stripe_created_at", startDate);
    }
    if (endDate) {
      // Add 1 day to include the end date
      const endDateObj = new Date(endDate);
      endDateObj.setDate(endDateObj.getDate() + 1);
      query = query.lt("stripe_created_at", endDateObj.toISOString());
    }
    if (source && source !== "all") {
      query = query.eq("source", source);
    }
    if (status && status !== "all") {
      if (status === "success") {
        query = query.in("status", ["succeeded", "paid"]);
      } else if (status === "failed") {
        query = query.in("status", ["failed", "requires_payment_method", "canceled"]);
      } else if (status === "refunded") {
        query = query.eq("status", "refunded");
      } else if (status === "pending") {
        query = query.in("status", ["pending", "requires_action"]);
      }
    }
    if (search) {
      query = query.or(`customer_email.ilike.%${search}%,stripe_payment_intent_id.ilike.%${search}%,external_transaction_id.ilike.%${search}%`);
    }

    const { data: transactions, error: txError } = await query;
    if (txError) throw txError;

    console.log(`📦 Fetched ${transactions?.length || 0} transactions`);

    // Fetch disputes if requested
    let disputes: any[] = [];
    if (includeDisputes) {
      let disputeQuery = supabase
        .from("disputes")
        .select("*")
        .order("created_at_external", { ascending: false });

      if (startDate) {
        disputeQuery = disputeQuery.gte("created_at_external", startDate);
      }
      if (endDate) {
        const endDateObj = new Date(endDate);
        endDateObj.setDate(endDateObj.getDate() + 1);
        disputeQuery = disputeQuery.lt("created_at_external", endDateObj.toISOString());
      }

      const { data: disputeData, error: dispError } = await disputeQuery;
      if (!dispError && disputeData) {
        disputes = disputeData;
        console.log(`⚠️ Fetched ${disputes.length} disputes`);
      }
    }

    // Generate CSV
    const csvHeaders = [
      "Fecha",
      "Hora",
      "Tipo",
      "Monto",
      "Moneda",
      "Estado",
      "Cliente Email",
      "Fuente",
      "ID Transacción",
      "ID Externo",
      "Tipo Pago",
      "Error",
      "Producto"
    ];

    const csvRows: string[] = [csvHeaders.join(",")];

    // Process transactions
    for (const tx of transactions || []) {
      const date = tx.stripe_created_at ? new Date(tx.stripe_created_at) : null;
      const isRefund = tx.status === "refunded";
      const amount = tx.amount / 100;
      const displayAmount = isRefund ? -amount : amount;

      const row = [
        date ? date.toISOString().split("T")[0] : "",
        date ? date.toISOString().split("T")[1].substring(0, 8) : "",
        isRefund ? "REEMBOLSO" : "CARGO",
        displayAmount.toFixed(2),
        (tx.currency || "USD").toUpperCase(),
        tx.status || "",
        tx.customer_email || "",
        tx.source || "stripe",
        tx.stripe_payment_intent_id || "",
        tx.external_transaction_id || "",
        tx.payment_type || "",
        tx.failure_message || tx.failure_code || "",
        tx.metadata?.product_name || ""
      ];

      csvRows.push(row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","));
    }

    // Process disputes
    for (const dispute of disputes) {
      const date = dispute.created_at_external ? new Date(dispute.created_at_external) : null;
      const amount = dispute.amount / 100;

      const row = [
        date ? date.toISOString().split("T")[0] : "",
        date ? date.toISOString().split("T")[1].substring(0, 8) : "",
        "DISPUTA",
        (-amount).toFixed(2), // Disputes are negative
        (dispute.currency || "USD").toUpperCase(),
        dispute.status || "",
        dispute.customer_email || "",
        dispute.source || "stripe",
        dispute.payment_intent_id || "",
        dispute.external_dispute_id || "",
        "dispute",
        dispute.reason || "",
        ""
      ];

      csvRows.push(row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","));
    }

    const csvContent = csvRows.join("\n");
    
    // Generate filename
    const now = new Date();
    const filename = `movimientos_${startDate || 'all'}_${endDate || now.toISOString().split('T')[0]}.csv`;

    console.log(`✅ Generated CSV with ${csvRows.length - 1} rows`);

    return new Response(csvContent, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Export error:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
