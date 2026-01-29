import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ReceiptSource = 'stripe' | 'paypal' | 'all';

export interface UnifiedReceipt {
  id: string;
  date: string;
  email: string | null;
  name: string | null;
  amount: number; // in cents
  currency: string;
  status: string;
  source: 'stripe' | 'paypal';
  externalId: string;
  productName?: string | null;
  pdfUrl?: string | null;
}

interface UseUnifiedReceiptsOptions {
  sourceFilter?: ReceiptSource;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export function useUnifiedReceipts(options: UseUnifiedReceiptsOptions = {}) {
  const { sourceFilter = 'all', startDate, endDate, limit = 1000 } = options;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["unified-receipts", sourceFilter, startDate, endDate, limit],
    queryFn: async () => {
      const results: UnifiedReceipt[] = [];

      // Fetch Stripe invoices (paid only)
      if (sourceFilter === 'all' || sourceFilter === 'stripe') {
        let stripeQuery = supabase
          .from("invoices")
          .select("id, stripe_invoice_id, stripe_created_at, customer_email, customer_name, amount_paid, currency, status, product_name, plan_name, pdf_url")
          .eq('status', 'paid')
          .order("stripe_created_at", { ascending: false })
          .limit(limit);

        if (startDate) stripeQuery = stripeQuery.gte('stripe_created_at', startDate);
        if (endDate) stripeQuery = stripeQuery.lte('stripe_created_at', endDate);

        const { data: stripeData } = await stripeQuery;

        for (const inv of stripeData || []) {
          results.push({
            id: inv.id,
            date: inv.stripe_created_at || '',
            email: inv.customer_email,
            name: inv.customer_name,
            amount: inv.amount_paid || 0,
            currency: inv.currency || 'usd',
            status: inv.status,
            source: 'stripe',
            externalId: inv.stripe_invoice_id,
            productName: inv.product_name || inv.plan_name,
            pdfUrl: inv.pdf_url,
          });
        }
      }

      // Fetch PayPal transactions (paid only)
      if (sourceFilter === 'all' || sourceFilter === 'paypal') {
        let paypalQuery = supabase
          .from("transactions")
          .select("id, stripe_payment_intent_id, stripe_created_at, customer_email, amount, currency, status, metadata")
          .eq('source', 'paypal')
          .eq('status', 'paid')
          .order("stripe_created_at", { ascending: false })
          .limit(limit);

        if (startDate) paypalQuery = paypalQuery.gte('stripe_created_at', startDate);
        if (endDate) paypalQuery = paypalQuery.lte('stripe_created_at', endDate);

        const { data: paypalData } = await paypalQuery;

        for (const tx of paypalData || []) {
          const meta = tx.metadata as Record<string, unknown> | null;
          results.push({
            id: tx.id,
            date: tx.stripe_created_at || '',
            email: tx.customer_email,
            name: meta?.payer_name as string || null,
            amount: tx.amount,
            currency: tx.currency || 'usd',
            status: tx.status,
            source: 'paypal',
            externalId: tx.stripe_payment_intent_id,
            productName: meta?.product_name as string || null,
            pdfUrl: null,
          });
        }
      }

      // Sort by date descending
      results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return results;
    },
  });

  // Calculate totals
  const receipts = data || [];
  
  const totals = {
    stripe: receipts
      .filter(r => r.source === 'stripe')
      .reduce((sum, r) => sum + r.amount, 0) / 100,
    paypal: receipts
      .filter(r => r.source === 'paypal')
      .reduce((sum, r) => sum + r.amount, 0) / 100,
    all: receipts.reduce((sum, r) => sum + r.amount, 0) / 100,
  };

  const counts = {
    stripe: receipts.filter(r => r.source === 'stripe').length,
    paypal: receipts.filter(r => r.source === 'paypal').length,
    all: receipts.length,
  };

  return {
    receipts,
    isLoading,
    refetch,
    totals,
    counts,
  };
}
