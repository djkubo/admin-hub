import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  status: "online" | "away" | "offline";
  max_chats: number;
  current_chats: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  contact_id: string;
  platform: string;
  status: "open" | "pending" | "resolved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  assigned_agent_id: string | null;
  assigned_at: string | null;
  first_message_at: string | null;
  last_message_at: string | null;
  last_customer_message_at: string | null;
  unread_count: number;
  is_bot_active: boolean;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined fields
  agent?: Agent | null;
}

// Fetch all agents
export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async (): Promise<Agent[]> => {
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .order("name");

      if (error) throw error;
      return (data || []) as Agent[];
    },
  });
}

// Fetch online agents only
export function useOnlineAgents() {
  return useQuery({
    queryKey: ["agents", "online"],
    queryFn: async (): Promise<Agent[]> => {
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .in("status", ["online", "away"])
        .order("name");

      if (error) throw error;
      return (data || []) as Agent[];
    },
    refetchInterval: 30000, // Refresh every 30s
  });
}

// Get current user's agent profile
export function useCurrentAgent() {
  return useQuery({
    queryKey: ["agents", "current"],
    queryFn: async (): Promise<Agent | null> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      // Avoid `.single()` here: PostgREST returns HTTP 406 when 0 rows match,
      // which shows up as noisy console errors in the browser even if we handle it.
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .eq("user_id", user.id)
        .limit(1);

      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : null;
      return (row as Agent | undefined) ?? null;
    },
  });
}

// Update agent status
export function useUpdateAgentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, status }: { agentId: string; status: "online" | "away" | "offline" }) => {
      const { error } = await supabase
        .from("agents")
        .update({ 
          status, 
          last_seen_at: new Date().toISOString() 
        })
        .eq("id", agentId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

// Fetch conversations with optional filters
export function useConversationsMultiagent(filter?: {
  status?: string;
  agentId?: string | null;
  unassigned?: boolean;
}) {
  return useQuery({
    queryKey: ["conversations", filter],
    queryFn: async (): Promise<Conversation[]> => {
      let query = supabase
        .from("conversations")
        .select(`
          *,
          agent:agents(*)
        `)
        .order("last_message_at", { ascending: false });

      if (filter?.status) {
        query = query.eq("status", filter.status);
      }
      
      if (filter?.unassigned) {
        query = query.is("assigned_agent_id", null);
      } else if (filter?.agentId) {
        query = query.eq("assigned_agent_id", filter.agentId);
      }

      const { data, error } = await query.limit(100);

      if (error) throw error;
      return (data || []) as Conversation[];
    },
  });
}

// Assign conversation to agent
export function useAssignConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      conversationId, 
      agentId, 
      assignedBy 
    }: { 
      conversationId: string; 
      agentId: string | null; 
      assignedBy?: string;
    }) => {
      // Update conversation
      const { error: convError } = await supabase
        .from("conversations")
        .update({ 
          assigned_agent_id: agentId,
          assigned_at: agentId ? new Date().toISOString() : null,
        })
        .eq("id", conversationId);

      if (convError) throw convError;

      // Log assignment if assigning (not unassigning)
      if (agentId) {
        const { error: assignError } = await supabase
          .from("chat_assignments")
          .insert({
            conversation_id: conversationId,
            agent_id: agentId,
            assigned_by: assignedBy || null,
          });

        if (assignError) throw assignError;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

// Update conversation status
export function useUpdateConversationStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      conversationId, 
      status 
    }: { 
      conversationId: string; 
      status: "open" | "pending" | "resolved" | "closed";
    }) => {
      const { error } = await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversationId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

// Create or update conversation from chat event
export function useUpsertConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ 
      contactId, 
      platform = "whatsapp",
      isCustomerMessage = false,
    }: { 
      contactId: string; 
      platform?: string;
      isCustomerMessage?: boolean;
    }) => {
      const now = new Date().toISOString();
      
      // Check if conversation exists
      const { data: existing } = await supabase
        .from("conversations")
        .select("id, unread_count")
        .eq("contact_id", contactId)
        .single();

      if (existing) {
        // Update existing
        const updates: Record<string, unknown> = {
          last_message_at: now,
        };
        
        if (isCustomerMessage) {
          updates.last_customer_message_at = now;
          updates.unread_count = (existing.unread_count || 0) + 1;
        }

        const { error } = await supabase
          .from("conversations")
          .update(updates)
          .eq("id", existing.id);

        if (error) throw error;
      } else {
        // Create new
        const { error } = await supabase
          .from("conversations")
          .insert({
            contact_id: contactId,
            platform,
            first_message_at: now,
            last_message_at: now,
            last_customer_message_at: isCustomerMessage ? now : null,
            unread_count: isCustomerMessage ? 1 : 0,
          });

        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
