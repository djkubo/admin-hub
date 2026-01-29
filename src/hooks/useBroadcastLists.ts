import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Database } from '@/integrations/supabase/types';

type BroadcastList = Database['public']['Tables']['broadcast_lists']['Row'];
type BroadcastListMember = Database['public']['Tables']['broadcast_list_members']['Row'];
type BroadcastMessage = Database['public']['Tables']['broadcast_messages']['Row'];

// Queries
export function useBroadcastLists() {
  return useQuery({
    queryKey: ['broadcast-lists'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('broadcast_lists')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      return data as BroadcastList[];
    },
  });
}

export function useBroadcastList(id: string | null) {
  return useQuery({
    queryKey: ['broadcast-list', id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from('broadcast_lists')
        .select('*')
        .eq('id', id)
        .single();
      
      if (error) throw error;
      return data as BroadcastList;
    },
    enabled: !!id,
  });
}

export function useBroadcastListMembers(listId: string | null) {
  return useQuery({
    queryKey: ['broadcast-list-members', listId],
    queryFn: async () => {
      if (!listId) return [];
      const { data, error } = await supabase
        .from('broadcast_list_members')
        .select(`
          *,
          client:clients(id, full_name, email, phone, phone_e164)
        `)
        .eq('list_id', listId)
        .order('added_at', { ascending: false });
      
      if (error) throw error;
      return data;
    },
    enabled: !!listId,
  });
}

export function useBroadcastHistory(listId?: string) {
  return useQuery({
    queryKey: ['broadcast-history', listId],
    queryFn: async () => {
      let query = supabase
        .from('broadcast_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (listId) {
        query = query.eq('list_id', listId);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data as BroadcastMessage[];
    },
  });
}

// Mutations
export function useCreateBroadcastList() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const { data: result, error } = await supabase
        .from('broadcast_lists')
        .insert({
          name: data.name,
          description: data.description || null,
        })
        .select()
        .single();
      
      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-lists'] });
      toast.success('Lista creada exitosamente');
    },
    onError: (error) => {
      toast.error(`Error al crear lista: ${error.message}`);
    },
  });
}

export function useUpdateBroadcastList() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: string; name?: string; description?: string }) => {
      const { data: result, error } = await supabase
        .from('broadcast_lists')
        .update(data)
        .eq('id', id)
        .select()
        .single();
      
      if (error) throw error;
      return result;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-lists'] });
      queryClient.invalidateQueries({ queryKey: ['broadcast-list', variables.id] });
      toast.success('Lista actualizada');
    },
    onError: (error) => {
      toast.error(`Error al actualizar: ${error.message}`);
    },
  });
}

export function useDeleteBroadcastList() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('broadcast_lists')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-lists'] });
      toast.success('Lista eliminada');
    },
    onError: (error) => {
      toast.error(`Error al eliminar: ${error.message}`);
    },
  });
}

export function useAddMembersToList() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ listId, clientIds }: { listId: string; clientIds: string[] }) => {
      const members = clientIds.map(clientId => ({
        list_id: listId,
        client_id: clientId,
      }));
      
      const { error } = await supabase
        .from('broadcast_list_members')
        .upsert(members, { onConflict: 'list_id,client_id', ignoreDuplicates: true });
      
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-list-members', variables.listId] });
      queryClient.invalidateQueries({ queryKey: ['broadcast-lists'] });
      toast.success('Miembros agregados');
    },
    onError: (error) => {
      toast.error(`Error al agregar miembros: ${error.message}`);
    },
  });
}

export function useRemoveMemberFromList() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ listId, clientId }: { listId: string; clientId: string }) => {
      const { error } = await supabase
        .from('broadcast_list_members')
        .delete()
        .eq('list_id', listId)
        .eq('client_id', clientId);
      
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-list-members', variables.listId] });
      queryClient.invalidateQueries({ queryKey: ['broadcast-lists'] });
      toast.success('Miembro removido');
    },
    onError: (error) => {
      toast.error(`Error al remover: ${error.message}`);
    },
  });
}

export function useSendBroadcast() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: {
      listId: string;
      messageContent: string;
      mediaUrl?: string;
      mediaType?: string;
      scheduledAt?: string;
    }) => {
      const { data: result, error } = await supabase.functions.invoke('send-broadcast', {
        body: {
          list_id: data.listId,
          message_content: data.messageContent,
          media_url: data.mediaUrl,
          media_type: data.mediaType,
          scheduled_at: data.scheduledAt,
        },
      });
      
      if (error) throw error;
      return result;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['broadcast-history', variables.listId] });
      queryClient.invalidateQueries({ queryKey: ['broadcast-history'] });
      toast.success('Difusión iniciada');
    },
    onError: (error) => {
      toast.error(`Error al enviar: ${error.message}`);
    },
  });
}
