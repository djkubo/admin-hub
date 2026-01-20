import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

export interface Transaction {
  id: string;
  stripe_payment_intent_id: string;
  payment_key: string | null; // CANONICAL dedup key
  payment_type: string | null; // 'new' | 'renewal' | 'trial_conversion'
  subscription_id: string | null;
  amount: number; // Always in CENTS
  currency: string | null; // Always lowercase (usd, mxn)
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  customer_email: string | null;
  stripe_customer_id: string | null;
  stripe_created_at: string | null;
  created_at: string | null;
  source: string | null; // 'stripe' | 'paypal'
  external_transaction_id: string | null;
  metadata: any | null;
}

export function useTransactions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: transactions = [], isLoading, error, refetch } = useQuery({
    queryKey: ["transactions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .order("stripe_created_at", { ascending: false });

      if (error) throw error;
      return data as Transaction[];
    },
  });

  const syncStripe = useMutation({
    mutationFn: async () => {
      return await invokeWithAdminKey("fetch-stripe", {});
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      const syncedCount = data?.synced_transactions ?? data?.synced_count ?? data?.synced ?? 0;
      toast({
        title: "Sincronización completada",
        description: `Se sincronizaron ${syncedCount} transacciones desde Stripe.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error de sincronización",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return {
    transactions,
    isLoading,
    error,
    syncStripe,
    refetch,
  };
}
