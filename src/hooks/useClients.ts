import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface Client {
  email: string;
  phone: string | null;
  full_name: string | null;
  status: string | null;
  last_sync: string | null;
  created_at: string | null;
}

export function useClients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: clients = [], isLoading, error, refetch } = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data as Client[];
    },
  });

  const addClient = useMutation({
    mutationFn: async (client: Omit<Client, "last_sync" | "created_at">) => {
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
    mutationFn: async (email: string) => {
      const { error } = await supabase
        .from("clients")
        .delete()
        .eq("email", email);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
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
  };
}
