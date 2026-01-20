import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Message {
  id: string;
  client_id: string | null;
  direction: "inbound" | "outbound";
  channel: "sms" | "whatsapp" | "email";
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  external_message_id: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
  client?: {
    id: string;
    full_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface Conversation {
  client_id: string | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  last_message: string;
  last_message_at: string;
  last_direction: "inbound" | "outbound";
  last_channel: string;
  unread_count: number;
  total_messages: number;
}

export function useMessages(clientId?: string) {
  return useQuery({
    queryKey: ["messages", clientId],
    queryFn: async () => {
      let query = supabase
        .from("messages")
        .select(`
          *,
          client:clients(id, full_name, email, phone)
        `)
        .order("created_at", { ascending: false })
        .limit(100);

      if (clientId) {
        query = query.eq("client_id", clientId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as Message[];
    },
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      // Get latest message per client with aggregations
      const { data, error } = await supabase
        .from("messages")
        .select(`
          client_id,
          body,
          created_at,
          direction,
          channel,
          read_at,
          from_address,
          client:clients(id, full_name, email, phone)
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Group by client and build conversation summaries
      const conversationMap = new Map<string, Conversation>();

      for (const msg of data || []) {
        const key = msg.client_id || "unknown";
        const existing = conversationMap.get(key);
        
        if (!existing) {
          const client = msg.client as { id: string; full_name: string | null; email: string | null; phone: string | null } | null;
          conversationMap.set(key, {
            client_id: msg.client_id,
            client_name: client?.full_name || null,
            client_email: client?.email || null,
            client_phone: client?.phone || msg.from_address,
            last_message: msg.body,
            last_message_at: msg.created_at,
            last_direction: msg.direction as "inbound" | "outbound",
            last_channel: msg.channel,
            unread_count: msg.direction === "inbound" && !msg.read_at ? 1 : 0,
            total_messages: 1,
          });
        } else {
          existing.total_messages++;
          if (msg.direction === "inbound" && !msg.read_at) {
            existing.unread_count++;
          }
        }
      }

      return Array.from(conversationMap.values()).sort(
        (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
      );
    },
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .eq("id", messageId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      clientId,
      channel,
      body,
      to,
    }: {
      clientId: string;
      channel: "sms" | "whatsapp";
      body: string;
      to: string;
    }) => {
      // First store the outbound message
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .insert({
          client_id: clientId,
          direction: "outbound",
          channel,
          to_address: to,
          body,
          status: "queued",
        })
        .select()
        .single();

      if (msgError) throw msgError;

      // Then send via appropriate channel
      const { data: settings } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "admin_api_key")
        .single();

      const adminKey = settings?.value;
      if (!adminKey) throw new Error("Admin API key not configured");

      const functionName = channel === "whatsapp" ? "send-sms" : "send-sms";
      const payload = channel === "whatsapp" 
        ? { to: `whatsapp:${to}`, message: body, client_id: clientId }
        : { to, message: body, client_id: clientId };

      const { error: sendError } = await supabase.functions.invoke(functionName, {
        body: payload,
        headers: { "x-admin-key": adminKey },
      });

      if (sendError) {
        // Update message status to failed
        await supabase
          .from("messages")
          .update({ status: "failed" })
          .eq("id", message.id);
        throw sendError;
      }

      // Update status to sent
      await supabase
        .from("messages")
        .update({ status: "sent" })
        .eq("id", message.id);

      return message;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
