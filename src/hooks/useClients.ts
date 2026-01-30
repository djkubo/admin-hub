import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface Client {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  status: string | null;
  payment_status: string | null;
  total_paid: number | null;
  total_spend: number | null;
  is_delinquent: boolean | null;
  stripe_customer_id: string | null;
  lifecycle_stage: string | null;
  trial_started_at: string | null;
  converted_at: string | null;
  last_sync: string | null;
  created_at: string | null;
  // Attribution fields
  acquisition_source: string | null;
  acquisition_campaign: string | null;
  acquisition_medium: string | null;
  acquisition_content: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  first_seen_at: string | null;
  last_lead_at: string | null;
  lead_status: string | null;
  // External IDs
  manychat_subscriber_id: string | null;
  ghl_contact_id: string | null;
  paypal_customer_id?: string | null;
  // Tags
  tags: string[] | null;
  // Staging fields (from view)
  import_status?: string | null;
  import_id?: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const VIP_THRESHOLD = 100000; // $1,000 USD in cents

export function useClients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const [vipOnly, setVipOnly] = useState(false);
  const [pageSize, setPageSize] = useState<number | 'all'>(DEFAULT_PAGE_SIZE);

  // OPTIMIZATION: Use RPC estimate for count (instant, no table scan)
  const { data: totalCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ["clients-count", vipOnly],
    queryFn: async () => {
      if (vipOnly) {
        // For VIP filter, we need actual count (small result set)
        const { count, error } = await supabase
          .from("clients")
          .select("*", { count: "exact", head: true })
          .gte("total_spend", VIP_THRESHOLD);
        if (error) throw error;
        return count || 0;
      }
      // Use pg_stat estimate for total count (instant)
      try {
        const { data } = await supabase.rpc('get_staging_counts_fast' as any);
        const clientsRow = (data as any[])?.find((r: any) => r.table_name === 'clients');
        return clientsRow?.row_estimate || 0;
      } catch {
        // Fallback to materialized view count
        const { data: mvData } = await supabase.from('mv_client_lifecycle_counts' as any).select('count');
        return (mvData as any[])?.reduce((sum: number, r: any) => sum + (r.count || 0), 0) || 0;
      }
    },
    staleTime: 120000, // Cache for 2 minutes
  });

  // OPTIMIZATION: Only select needed columns (not SELECT *)
  const { data: clients = [], isLoading, error, refetch: refetchClients } = useQuery({
    queryKey: ["clients", page, vipOnly, pageSize],
    queryFn: async () => {
      // Only fetch essential columns for table display
      const columns = "id, email, phone, full_name, status, payment_status, total_paid, total_spend, is_delinquent, stripe_customer_id, lifecycle_stage, created_at, acquisition_source, utm_source, manychat_subscriber_id, ghl_contact_id, paypal_customer_id, tags";
      
      let query = supabase
        .from("clients")
        .select(columns)
        .order("total_spend", { ascending: false, nullsFirst: false });

      if (vipOnly) {
        query = query.gte("total_spend", VIP_THRESHOLD);
      }

      // Always paginate - no "all" option for 221k rows
      const effectivePageSize = pageSize === 'all' ? 100 : pageSize;
      const from = page * effectivePageSize;
      const to = from + effectivePageSize - 1;
      query = query.range(from, to);

      const { data, error } = await query;

      if (error) throw error;
      return data as Client[];
    },
    staleTime: 60000, // Cache for 1 minute
  });

  const refetch = () => {
    refetchCount();
    refetchClients();
  };
  const totalPages = pageSize === 'all' ? 1 : Math.ceil(totalCount / pageSize);
  
  // Reset to page 0 when changing page size
  const handleSetPageSize = (size: number | 'all') => {
    setPage(0);
    setPageSize(size);
  };

  const addClient = useMutation({
    mutationFn: async (client: {
      email: string | null;
      phone: string | null;
      full_name: string | null;
      status: string;
    }) => {
      const { data, error } = await supabase
        .from("clients")
        .insert([{ 
          ...client, 
          last_sync: new Date().toISOString(),
          lifecycle_stage: 'LEAD'
        }])
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["clients-count"] });
      toast({
        title: "Cliente agregado",
        description: "El cliente se ha agregado correctamente.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteClient = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("clients")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["clients-count"] });
      toast({
        title: "Cliente eliminado",
        description: "El cliente se ha eliminado correctamente.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Check if client is VIP (>$1000 USD lifetime spend)
  const isVip = (client: Client) => (client.total_spend || 0) >= VIP_THRESHOLD;

  return {
    clients,
    isLoading,
    error,
    addClient,
    deleteClient,
    refetch,
    totalCount,
    page,
    setPage,
    totalPages,
    pageSize,
    setPageSize: handleSetPageSize,
    vipOnly,
    setVipOnly,
    isVip,
    VIP_THRESHOLD,
  };
}
