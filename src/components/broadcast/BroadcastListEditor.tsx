import React, { useEffect, useState } from 'react';
import { X, Search, UserPlus, UserMinus, Tag, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useBroadcastList,
  useBroadcastListMembers,
  useCreateBroadcastList,
  useUpdateBroadcastList,
  useAddMembersToList,
  useRemoveMemberFromList,
} from '@/hooks/useBroadcastLists';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';

interface BroadcastListEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId: string | null;
}

export function BroadcastListEditor({ open, onOpenChange, listId }: BroadcastListEditorProps) {
  const { data: list } = useBroadcastList(listId);
  const { data: members } = useBroadcastListMembers(listId);
  const createMutation = useCreateBroadcastList();
  const updateMutation = useUpdateBroadcastList();
  const addMembersMutation = useAddMembersToList();
  const removeMemberMutation = useRemoveMemberFromList();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [selectedClients, setSelectedClients] = useState<string[]>([]);

  // Fetch clients for adding
  const { data: clients } = useQuery({
    queryKey: ['clients-for-broadcast', search, tagFilter],
    queryFn: async () => {
      let query = supabase
        .from('clients')
        .select('id, full_name, email, phone, phone_e164, tags')
        .not('phone_e164', 'is', null)
        .limit(100);

      if (search) {
        query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
      }

      if (tagFilter) {
        query = query.contains('tags', [tagFilter]);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: open,
  });

  // Fetch unique tags
  const { data: allTags } = useQuery({
    queryKey: ['all-client-tags'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('clients')
        .select('tags')
        .not('tags', 'is', null);
      
      if (error) throw error;
      
      const tagSet = new Set<string>();
      data?.forEach((client) => {
        if (client.tags) {
          client.tags.forEach((tag: string) => tagSet.add(tag));
        }
      });
      return Array.from(tagSet).sort();
    },
    enabled: open,
  });

  // Current member IDs for filtering
  const memberClientIds = new Set(members?.map((m) => m.client_id) || []);

  useEffect(() => {
    if (list) {
      setName(list.name);
      setDescription(list.description || '');
    } else {
      setName('');
      setDescription('');
    }
    setSelectedClients([]);
  }, [list, open]);

  const handleSave = async () => {
    if (!name.trim()) return;

    if (listId) {
      await updateMutation.mutateAsync({ id: listId, name, description });
    } else {
      const newList = await createMutation.mutateAsync({ name, description });
      // If clients selected, add them
      if (selectedClients.length > 0 && newList?.id) {
        await addMembersMutation.mutateAsync({ listId: newList.id, clientIds: selectedClients });
      }
    }
    onOpenChange(false);
  };

  const handleAddSelected = async () => {
    if (!listId || selectedClients.length === 0) return;
    await addMembersMutation.mutateAsync({ listId, clientIds: selectedClients });
    setSelectedClients([]);
  };

  const handleRemoveMember = async (clientId: string) => {
    if (!listId) return;
    await removeMemberMutation.mutateAsync({ listId, clientId });
  };

  const toggleClientSelection = (clientId: string) => {
    setSelectedClients((prev) =>
      prev.includes(clientId)
        ? prev.filter((id) => id !== clientId)
        : [...prev, clientId]
    );
  };

  const availableClients = clients?.filter((c) => !memberClientIds.has(c.id)) || [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col">
        <SheetHeader>
          <SheetTitle>{listId ? 'Editar Lista' : 'Nueva Lista de Difusión'}</SheetTitle>
          <SheetDescription>
            {listId ? 'Modifica los detalles y miembros de la lista' : 'Crea una nueva lista para enviar mensajes masivos'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4 py-4">
          {/* Basic Info */}
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="name">Nombre de la lista</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej: Clientes VIP"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Descripción (opcional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe el propósito de esta lista..."
                rows={2}
              />
            </div>
          </div>

          {/* Members Section */}
          {listId && (
            <>
              {/* Current Members */}
              <div className="space-y-2">
                <Label>Miembros actuales ({members?.length || 0})</Label>
                <ScrollArea className="h-32 border rounded-md p-2">
                  {members && members.length > 0 ? (
                    <div className="space-y-1">
                      {members.map((member: any) => (
                        <div
                          key={member.id}
                          className="flex items-center justify-between p-2 rounded-md hover:bg-muted"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {member.client?.full_name || 'Sin nombre'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {member.client?.phone_e164 || member.client?.phone}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRemoveMember(member.client_id)}
                          >
                            <UserMinus className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No hay miembros en esta lista
                    </p>
                  )}
                </ScrollArea>
              </div>

              {/* Add Members */}
              <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                <Label>Agregar miembros</Label>
                
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Buscar por nombre, email o teléfono..."
                      className="pl-9"
                    />
                  </div>
                  <Select value={tagFilter} onValueChange={setTagFilter}>
                    <SelectTrigger className="w-40">
                      <Tag className="h-4 w-4 mr-2" />
                      <SelectValue placeholder="Filtrar tag" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Todos</SelectItem>
                      {allTags?.map((tag) => (
                        <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <ScrollArea className="flex-1 border rounded-md p-2">
                  {availableClients.length > 0 ? (
                    <div className="space-y-1">
                      {availableClients.map((client) => (
                        <div
                          key={client.id}
                          className="flex items-center gap-2 p-2 rounded-md hover:bg-muted cursor-pointer"
                          onClick={() => toggleClientSelection(client.id)}
                        >
                          <Checkbox
                            checked={selectedClients.includes(client.id)}
                            onCheckedChange={() => toggleClientSelection(client.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {client.full_name || 'Sin nombre'}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {client.phone_e164 || client.phone} • {client.email || 'Sin email'}
                            </p>
                          </div>
                          {client.tags && client.tags.length > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {client.tags[0]}
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {search || tagFilter ? 'No se encontraron contactos' : 'Busca o filtra para agregar miembros'}
                    </p>
                  )}
                </ScrollArea>

                {selectedClients.length > 0 && (
                  <Button onClick={handleAddSelected} disabled={addMembersMutation.isPending}>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Agregar {selectedClients.length} seleccionados
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || createMutation.isPending || updateMutation.isPending}
          >
            {listId ? 'Guardar Cambios' : 'Crear Lista'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
