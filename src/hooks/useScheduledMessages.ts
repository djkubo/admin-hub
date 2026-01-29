import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface ScheduledMessage {
  id: string;
  contact_id: string;
  message: string | null;
  media_url: string | null;
  media_type: string | null;
  media_filename: string | null;
  scheduled_at: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  sent_at: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Fetch all scheduled messages for a contact
export function useScheduledMessages(contactId?: string) {
  return useQuery({
    queryKey: ["scheduled-messages", contactId],
    queryFn: async () => {
      let query = supabase
        .from("scheduled_messages")
        .select("*")
        .order("scheduled_at", { ascending: true });

      if (contactId) {
        query = query.eq("contact_id", contactId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as ScheduledMessage[];
    },
    enabled: true,
  });
}

// Fetch pending scheduled messages
export function usePendingScheduledMessages() {
  return useQuery({
    queryKey: ["scheduled-messages", "pending"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("scheduled_messages")
        .select("*")
        .eq("status", "pending")
        .order("scheduled_at", { ascending: true });

      if (error) throw error;
      return data as ScheduledMessage[];
    },
  });
}

// Create a scheduled message
export function useCreateScheduledMessage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (params: {
      contact_id: string;
      message?: string;
      media_url?: string;
      media_type?: string;
      media_filename?: string;
      scheduled_at: Date;
    }) => {
      const { data, error } = await supabase
        .from("scheduled_messages")
        .insert({
          contact_id: params.contact_id,
          message: params.message || null,
          media_url: params.media_url || null,
          media_type: params.media_type || null,
          media_filename: params.media_filename || null,
          scheduled_at: params.scheduled_at.toISOString(),
          status: "pending",
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-messages"] });
      toast({
        title: "Mensaje programado",
        description: `Se enviará el ${new Date(variables.scheduled_at).toLocaleString("es-ES")}`,
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "No se pudo programar el mensaje",
        variant: "destructive",
      });
    },
  });
}

// Cancel a scheduled message
export function useCancelScheduledMessage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase
        .from("scheduled_messages")
        .update({ status: "cancelled" })
        .eq("id", messageId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-messages"] });
      toast({
        title: "Mensaje cancelado",
        description: "El mensaje programado fue cancelado",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "No se pudo cancelar",
        variant: "destructive",
      });
    },
  });
}
