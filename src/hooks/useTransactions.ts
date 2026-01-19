import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface Transaction {
  id: string;
  stripe_payment_intent_id: string;
  amount: number;
  currency: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  customer_email: string | null;
  stripe_customer_id: string | null;
  stripe_created_at: string | null;
  created_at: string | null;
  source: string | null;
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
      const { data, error } = await supabase.functions.invoke("fetch-stripe", {
        method: "POST",
      });

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      // CRITICAL FIX #5: Read synced_transactions instead of synced
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
