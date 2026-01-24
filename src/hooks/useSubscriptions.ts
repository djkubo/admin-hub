import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

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
  provider: string | null; // 'stripe' | 'paypal'
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

interface SyncRun {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number | null;
  total_inserted: number | null;
  error_message: string | null;
}

export function useSubscriptions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeSyncId, setActiveSyncId] = useState<string | null>(null);

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
        
        // Only show if started less than 10 minutes ago
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
    refetchInterval: activeSyncId ? 2000 : false, // Poll every 2 seconds
  });

  // Handle sync completion
  useEffect(() => {
    if (syncStatus?.status === "completed") {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
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

  const { data: subscriptions = [], isLoading, error, refetch } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .order("amount", { ascending: false });

      if (error) throw error;
      return data as Subscription[];
    },
    refetchInterval: 60000, // Refetch every minute for near-realtime updates
  });

  // Realtime subscription for subscriptions table
  useEffect(() => {
    const channel = supabase.channel('subscriptions-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'subscriptions' }, () => {
        refetch();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'subscriptions' }, () => {
        refetch();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'subscriptions' }, () => {
        refetch();
      })
      .subscribe();
      
    return () => { supabase.removeChannel(channel); };
  }, [refetch]);

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
      const result = await invokeWithAdminKey("fetch-subscriptions", {});
      return result;
    },
    onSuccess: (data) => {
      if (data.status === "running" && data.syncRunId) {
        setActiveSyncId(data.syncRunId);
        toast({
          title: "Sincronización iniciada",
          description: "El proceso continúa en segundo plano. Puedes recargar la página.",
        });
      } else if (data.status === "completed") {
        queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
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

  // Check if sync is in progress
  const isSyncing = !!activeSyncId || syncSubscriptions.isPending;
  const syncProgress = syncStatus ? {
    fetched: syncStatus.total_fetched || 0,
    inserted: syncStatus.total_inserted || 0,
    status: syncStatus.status,
  } : null;

  return {
    subscriptions,
    isLoading,
    error,
    syncSubscriptions,
    revenueByPlan,
    totalActiveRevenue,
    totalActiveCount,
    isSyncing,
    syncProgress,
  };
}
