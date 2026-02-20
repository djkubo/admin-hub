import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
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

export type ClientFilter = 'all' | 'customer' | 'lead' | 'trial' | 'past_due' | 'churn' | 'vip' | 'no_phone';

const DEFAULT_PAGE_SIZE = 50;
const VIP_THRESHOLD = 100000; // $1,000 USD in cents

interface UseClientsOptions {
  searchQuery?: string;
  statusFilter?: ClientFilter;
}

export function useClients(options: UseClientsOptions = {}) {
  const { searchQuery = '', statusFilter = 'all' } = options;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number | 'all'>(DEFAULT_PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [searchQuery, statusFilter]);

  // SERVER-SIDE: Count query with filters
  const { data: totalCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ["clients-count", searchQuery, statusFilter],
    queryFn: async () => {
      let query = supabase
        .from("clients")
        .select("id", { count: "exact" });

      // Apply search filter server-side
      if (searchQuery && searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
      }

      // Apply status filter server-side
      query = applyStatusFilter(query, statusFilter);

      // Keep the payload minimal; we only need the count header.
      query = query.range(0, 0);

      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    },
    staleTime: 30000,
  });

  // SERVER-SIDE: Data query with filters and pagination
  const { data: clients = [], isLoading, error, refetch: refetchClients } = useQuery({
    queryKey: ["clients", page, pageSize, searchQuery, statusFilter],
    queryFn: async () => {
      const columns = "id, email, phone, full_name, status, payment_status, total_paid, total_spend, is_delinquent, stripe_customer_id, lifecycle_stage, created_at, acquisition_source, utm_source, manychat_subscriber_id, ghl_contact_id, paypal_customer_id, tags";
      
      let query = supabase
        .from("clients")
        .select(columns)
        .order("total_spend", { ascending: false, nullsFirst: false });

      // Apply search filter server-side
      if (searchQuery && searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
      }

      // Apply status filter server-side
      query = applyStatusFilter(query, statusFilter);

      // Pagination
      const effectivePageSize = pageSize === 'all' ? 200 : pageSize;
      const from = page * effectivePageSize;
      const to = from + effectivePageSize - 1;
      query = query.range(from, to);

      const { data, error } = await query;
      if (error) throw error;
      return data as Client[];
    },
    staleTime: 30000,
  });

  const refetch = () => {
    refetchCount();
    refetchClients();
  };

  const totalPages = pageSize === 'all' ? 1 : Math.ceil(totalCount / (pageSize || DEFAULT_PAGE_SIZE));
  
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
    isVip,
    VIP_THRESHOLD,
  };
}

// Helper function to apply status filters to Supabase query
function applyStatusFilter(query: any, filter: ClientFilter) {
  switch (filter) {
    case 'customer':
      return query.eq('lifecycle_stage', 'CUSTOMER');
    case 'lead':
      return query.eq('lifecycle_stage', 'LEAD');
    case 'trial':
      return query.eq('lifecycle_stage', 'TRIAL');
    case 'past_due':
      return query.eq('is_delinquent', true);
    case 'churn':
      return query.eq('lifecycle_stage', 'CHURN');
    case 'vip':
      return query.gte('total_spend', VIP_THRESHOLD);
    case 'no_phone':
      return query.is('phone', null);
    default:
      return query;
  }
}
