import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

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
  provider: string | null;
  trial_start: string | null;
  trial_end: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
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

export interface StatusBreakdown {
  active: number;
  trialing: number;
  past_due: number;
  unpaid: number;
  canceled: number;
  incomplete: number;
  incomplete_expired: number;
  paused: number;
}

interface SyncRun {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number | null;
  total_inserted: number | null;
  error_message: string | null;
}

interface SubscriptionMetrics {
  total_count: number;
  active_count: number;
  trialing_count: number;
  past_due_count: number;
  unpaid_count: number;
  canceled_count: number;
  paused_count: number;
  incomplete_count: number;
  mrr: number;
  at_risk_amount: number;
  stripe_count: number;
  paypal_count: number;
}

interface UseSubscriptionsOptions {
  page?: number;
  pageSize?: number;
  statusFilter?: string;
  searchQuery?: string;
  providerFilter?: 'all' | 'stripe' | 'paypal';
}

export function useSubscriptions(options: UseSubscriptionsOptions = {}) {
  const {
    page = 1,
    pageSize = 50,
    statusFilter = 'all',
    searchQuery = '',
    providerFilter = 'all',
  } = options;
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeSyncId, setActiveSyncId] = useState<string | null>(null);

  // Calculate range for pagination
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Check for active sync on mount
  useEffect(() => {
    const checkActiveSync = async () => {
      const { data } = await supabase
        .from("sync_runs")
        .select("*")
        .eq("source", "subscriptions")
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1);
      
      if (data && data.length > 0) {
        const sync = data[0];
        const startedAt = new Date(sync.started_at);
        const minutesAgo = (Date.now() - startedAt.getTime()) / 1000 / 60;
        
        if (minutesAgo < 10) {
          setActiveSyncId(sync.id);
        }
      }
    };
    checkActiveSync();
  }, []);

  // Poll sync status when active
  const { data: syncStatus } = useQuery({
    queryKey: ["sync-status", activeSyncId],
    queryFn: async () => {
      if (!activeSyncId) return null;
      
      const { data, error } = await supabase
        .from("sync_runs")
        .select("*")
        .eq("id", activeSyncId)
        .single();
      
      if (error) throw error;
      return data as SyncRun;
    },
    enabled: !!activeSyncId,
    refetchInterval: activeSyncId ? 5000 : false,
  });

  // Handle sync completion
  useEffect(() => {
    if (syncStatus?.status === "completed") {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-metrics"] });
      queryClient.invalidateQueries({ queryKey: ["revenue-by-plan"] });
      toast({
        title: "Sincronización completada",
        description: `${syncStatus.total_inserted || 0} suscripciones actualizadas`,
      });
      setActiveSyncId(null);
    } else if (syncStatus?.status === "failed") {
      toast({
        title: "Error de sincronización",
        description: syncStatus.error_message || "Error desconocido",
        variant: "destructive",
      });
      setActiveSyncId(null);
    }
  }, [syncStatus?.status, syncStatus?.total_inserted, syncStatus?.error_message, queryClient, toast]);

  // Paginated subscriptions for table display
  const { data: paginatedData, isLoading, error, refetch } = useQuery({
    queryKey: ["subscriptions", page, pageSize, statusFilter, searchQuery, providerFilter],
    queryFn: async () => {
      let query = supabase
        .from("subscriptions")
        .select("*", { count: 'exact' })
        .order("amount", { ascending: false })
        .range(from, to);

      // Status filter
      if (statusFilter !== 'all') {
        if (statusFilter === 'at_risk') {
          query = query.in('status', ['past_due', 'unpaid']);
        } else {
          query = query.eq('status', statusFilter);
        }
      }

      // Provider filter
      if (providerFilter === 'stripe') {
        query = query.or('provider.is.null,provider.eq.stripe');
      } else if (providerFilter === 'paypal') {
        query = query.eq('provider', 'paypal');
      }

      // Search filter
      if (searchQuery) {
        query = query.or(`customer_email.ilike.%${searchQuery}%,plan_name.ilike.%${searchQuery}%`);
      }

      const { data, error, count } = await query;

      if (error) throw error;
      return { subscriptions: data as Subscription[], totalCount: count || 0 };
    },
    refetchInterval: 120000,
    staleTime: 60000,
  });

  const subscriptions = paginatedData?.subscriptions || [];
  const totalCount = paginatedData?.totalCount || 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  // SERVER-SIDE METRICS: Use RPC for accurate totals across entire dataset
  const { data: metrics } = useQuery({
    queryKey: ["subscription-metrics"],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_subscription_metrics');
      if (error) {
        console.warn('get_subscription_metrics RPC error:', error);
        return null;
      }
      return data?.[0] as SubscriptionMetrics | undefined;
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  // SERVER-SIDE: Revenue by plan from RPC
  const { data: revenueByPlanData } = useQuery({
    queryKey: ["revenue-by-plan"],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_revenue_by_plan', { limit_count: 10 });
      if (error) {
        console.warn('get_revenue_by_plan RPC error:', error);
        return [];
      }
      return data as { plan_name: string; subscription_count: number; total_revenue: number; percentage: number }[];
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  // Transform revenue by plan to expected format
  const revenueByPlan: PlanRevenue[] = (() => {
    if (!revenueByPlanData) return [];
    let cumulative = 0;
    return revenueByPlanData.map(plan => {
      cumulative += Number(plan.percentage) || 0;
      return {
        name: plan.plan_name,
        count: Number(plan.subscription_count) || 0,
        revenue: Number(plan.total_revenue) || 0,
        percentage: Number(plan.percentage) || 0,
        cumulative,
      };
    });
  })();

  // Status breakdown from RPC metrics
  const statusBreakdown: StatusBreakdown = {
    active: metrics?.active_count || 0,
    trialing: metrics?.trialing_count || 0,
    past_due: metrics?.past_due_count || 0,
    unpaid: metrics?.unpaid_count || 0,
    canceled: metrics?.canceled_count || 0,
    incomplete: metrics?.incomplete_count || 0,
    incomplete_expired: 0,
    paused: metrics?.paused_count || 0,
  };

  // OPTIMIZATION: Debounced realtime subscription
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refetch();
        queryClient.invalidateQueries({ queryKey: ["subscription-metrics"] });
        queryClient.invalidateQueries({ queryKey: ["revenue-by-plan"] });
      }, 2000);
    };
    
    const channel = supabase.channel('subscriptions-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subscriptions' }, debouncedRefetch)
      .subscribe();
      
    return () => { 
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel); 
    };
  }, [refetch, queryClient]);

  // Use server-side metrics for accurate totals
  const totalActiveRevenue = metrics?.mrr || 0;
  const totalActiveCount = metrics?.active_count || 0;
  const revenueAtRisk = metrics?.at_risk_amount || 0;
  const atRiskCount = (metrics?.past_due_count || 0) + (metrics?.unpaid_count || 0);

  const syncSubscriptions = useMutation({
    mutationFn: async () => {
      const result = await invokeWithAdminKey<{ status?: string; syncRunId?: string }>("fetch-subscriptions", {});
      return result;
    },
    onSuccess: (data) => {
      if (data?.status === "running" && data?.syncRunId) {
        setActiveSyncId(data.syncRunId);
        toast({
          title: "Sincronización iniciada",
          description: "El proceso continúa en segundo plano.",
        });
      } else if (data?.status === "completed") {
        queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
        queryClient.invalidateQueries({ queryKey: ["subscription-metrics"] });
        toast({
          title: "Suscripciones sincronizadas",
          description: `Sincronización completada`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error de sincronización",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Sync PayPal subscriptions
  const syncPayPalSubscriptions = useMutation({
    mutationFn: async () => {
      const result = await invokeWithAdminKey<{ success?: boolean; syncRunId?: string; upserted?: number }>("fetch-paypal-subscriptions", {});
      return result;
    },
    onSuccess: (data) => {
      if (data?.success) {
        queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
        queryClient.invalidateQueries({ queryKey: ["subscription-metrics"] });
        toast({
          title: "PayPal sincronizado",
          description: `${data.upserted || 0} suscripciones de PayPal actualizadas`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error de sincronización PayPal",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isSyncing = !!activeSyncId || syncSubscriptions.isPending || syncPayPalSubscriptions.isPending;
  const syncProgress = syncStatus ? {
    fetched: syncStatus.total_fetched || 0,
    inserted: syncStatus.total_inserted || 0,
    status: syncStatus.status,
  } : null;

  return {
    subscriptions,
    isLoading,
    error,
    refetch,
    syncSubscriptions,
    syncPayPalSubscriptions,
    // Pagination
    page,
    pageSize,
    totalCount,
    totalPages,
    // Server-side metrics (accurate for entire dataset)
    revenueByPlan,
    totalActiveRevenue,
    totalActiveCount,
    statusBreakdown,
    revenueAtRisk,
    atRiskCount,
    // Provider breakdown
    stripeCount: metrics?.stripe_count || 0,
    paypalCount: metrics?.paypal_count || 0,
    // Sync state
    isSyncing,
    syncProgress,
  };
}
