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
  last_sync: string | null;
  created_at: string | null;
}

const PAGE_SIZE = 50;

export function useClients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(0);

  // Query for total count (exact count without downloading data)
  const { data: totalCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ["clients-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("clients")
        .select("*", { count: "exact", head: true });

      if (error) throw error;
      return count || 0;
    },
  });

  // Query for paginated clients
  const { data: clients = [], isLoading, error, refetch: refetchClients } = useQuery({
    queryKey: ["clients", page],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error) throw error;
      return data as Client[];
    },
  });

  const refetch = () => {
    refetchCount();
    refetchClients();
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const addClient = useMutation({
    mutationFn: async (client: Omit<Client, "id" | "last_sync" | "created_at">) => {
      const { data, error } = await supabase
        .from("clients")
        .insert([{ ...client, last_sync: new Date().toISOString() }])
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
    pageSize: PAGE_SIZE,
  };
}
