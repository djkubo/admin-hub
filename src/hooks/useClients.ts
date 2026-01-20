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
  // Tags
  tags: string[] | null;
}

const DEFAULT_PAGE_SIZE = 50;
const VIP_THRESHOLD = 100000; // $1,000 USD in cents

export function useClients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const [vipOnly, setVipOnly] = useState(false);
  const [pageSize, setPageSize] = useState<number | 'all'>(DEFAULT_PAGE_SIZE);

  // Query for total count (exact count without downloading data)
  const { data: totalCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ["clients-count", vipOnly],
    queryFn: async () => {
      let query = supabase
        .from("clients")
        .select("*", { count: "exact", head: true });

      if (vipOnly) {
        query = query.gte("total_spend", VIP_THRESHOLD);
      }

      const { count, error } = await query;

      if (error) throw error;
      return count || 0;
    },
  });

  // Query for paginated clients
  const { data: clients = [], isLoading, error, refetch: refetchClients } = useQuery({
    queryKey: ["clients", page, vipOnly, pageSize],
    queryFn: async () => {
      let query = supabase
        .from("clients")
        .select("*")
        .order("total_spend", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (vipOnly) {
        query = query.gte("total_spend", VIP_THRESHOLD);
      }

      // Apply pagination only if not "all"
      if (pageSize !== 'all') {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);
      } else {
        // Limit to 10000 for safety
        query = query.limit(10000);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as Client[];
    },
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
