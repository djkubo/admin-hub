import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

export interface Invoice {
  id: string;
  stripe_invoice_id: string;
  customer_email: string | null;
  stripe_customer_id: string | null;
  amount_due: number;
  currency: string;
  status: string;
  period_end: string | null;
  next_payment_attempt: string | null;
  hosted_invoice_url: string | null;
  created_at: string;
  updated_at: string;
}

export function useInvoices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch pending invoices (draft + open)
  const { data: invoices = [], isLoading, refetch } = useQuery({
    queryKey: ["invoices"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .in("status", ["draft", "open"])
        .order("next_payment_attempt", { ascending: true, nullsFirst: false });

      if (error) throw error;
      return data as Invoice[];
    },
  });

  // Sync invoices from Stripe
  const syncInvoices = useMutation({
    mutationFn: async () => {
      return await invokeWithAdminKey("fetch-invoices", {});
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      const excludedMsg = data.excludedCount > 0 
        ? ` (${data.excludedCount} excluidas por suscripción cancelada)`
        : "";
      toast({
        title: "Facturas sincronizadas",
        description: `${data.draftCount} borradores, ${data.openCount} abiertas.${excludedMsg} Total: $${(data.totalPending / 100).toFixed(2)}`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error al sincronizar facturas",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Calculate total pending amount (in dollars)
  const totalPending = invoices.reduce((sum, inv) => sum + inv.amount_due, 0) / 100;

  // Get invoices due in next 72 hours
  const next72Hours = new Date();
  next72Hours.setHours(next72Hours.getHours() + 72);

  const invoicesNext72h = invoices.filter((inv) => {
    if (!inv.next_payment_attempt) return false;
    const attemptDate = new Date(inv.next_payment_attempt);
    return attemptDate <= next72Hours;
  });

  const totalNext72h = invoicesNext72h.reduce((sum, inv) => sum + inv.amount_due, 0) / 100;

  return {
    invoices,
    isLoading,
    refetch,
    syncInvoices,
    totalPending,
    totalNext72h,
    invoicesNext72h,
  };
}
