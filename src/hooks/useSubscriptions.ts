import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface Subscription {
  id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  customer_email: string | null;
  plan_name: string;
  plan_id: string | null;
  amount: number;
  currency: string | null;
  interval: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PlanRevenue {
  name: string;
  count: number;
  revenue: number;
  percentage: number;
  cumulative: number;
}

export function useSubscriptions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: subscriptions = [], isLoading, error } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .order("amount", { ascending: false });

      if (error) throw error;
      return data as Subscription[];
    },
  });

  // Calculate revenue by plan with Pareto analysis
  const revenueByPlan: PlanRevenue[] = (() => {
    const activeSubscriptions = subscriptions.filter(
      (s) => s.status === "active" || s.status === "trialing"
    );

    const planMap: Record<string, { count: number; revenue: number }> = {};

    for (const sub of activeSubscriptions) {
      const planName = sub.plan_name || "Unknown Plan";
      if (!planMap[planName]) {
        planMap[planName] = { count: 0, revenue: 0 };
      }
      planMap[planName].count += 1;
      planMap[planName].revenue += sub.amount;
    }

    const sorted = Object.entries(planMap)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = sorted.reduce((sum, p) => sum + p.revenue, 0);
    let cumulative = 0;

    return sorted.map((plan) => {
      const percentage = totalRevenue > 0 ? (plan.revenue / totalRevenue) * 100 : 0;
      cumulative += percentage;
      return {
        ...plan,
        percentage,
        cumulative,
      };
    });
  })();

  const totalActiveRevenue = revenueByPlan.reduce((sum, p) => sum + p.revenue, 0);
  const totalActiveCount = revenueByPlan.reduce((sum, p) => sum + p.count, 0);

  const syncSubscriptions = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("fetch-subscriptions");
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      toast({
        title: "Suscripciones sincronizadas",
        description: `${data.upserted} suscripciones actualizadas desde Stripe`,
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
    subscriptions,
    isLoading,
    error,
    syncSubscriptions,
    revenueByPlan,
    totalActiveRevenue,
    totalActiveCount,
  };
}
