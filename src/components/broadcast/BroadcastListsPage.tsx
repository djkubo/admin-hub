import React, { useState } from 'react';
import { Plus, Users, Send, Trash2, Edit, Clock, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useBroadcastLists, useDeleteBroadcastList } from '@/hooks/useBroadcastLists';
import { BroadcastListEditor } from './BroadcastListEditor';
import { BroadcastComposer } from './BroadcastComposer';
import { BroadcastHistoryPanel } from './BroadcastHistoryPanel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

export function BroadcastListsPage() {
  const { data: lists, isLoading } = useBroadcastLists();
  const deleteMutation = useDeleteBroadcastList();
  
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [deleteListId, setDeleteListId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const handleDelete = () => {
    if (deleteListId) {
      deleteMutation.mutate(deleteListId);
      setDeleteListId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Listas de Difusión</h1>
          <p className="text-muted-foreground">
            Envía mensajes masivos personalizados a grupos de contactos
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowHistory(true)}>
            <Clock className="h-4 w-4 mr-2" />
            Historial
          </Button>
          <Button onClick={() => { setSelectedListId(null); setIsEditorOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" />
            Nueva Lista
          </Button>
        </div>
      </div>

      {/* Lists Grid */}
      {lists && lists.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {lists.map((list) => (
            <Card key={list.id} className="bg-card border-border hover:border-primary/50 transition-colors">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Users className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{list.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {list.member_count || 0} miembros
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {list.member_count || 0}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {list.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {list.description}
                  </p>
                )}
                
                {list.last_broadcast_at && (
                  <p className="text-xs text-muted-foreground">
                    Último envío: {format(new Date(list.last_broadcast_at), "d MMM yyyy, HH:mm", { locale: es })}
                  </p>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => { setSelectedListId(list.id); setIsComposerOpen(true); }}
                    disabled={!list.member_count || list.member_count === 0}
                  >
                    <Send className="h-3 w-3 mr-1" />
                    Enviar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setSelectedListId(list.id); setIsEditorOpen(true); }}
                  >
                    <Edit className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteListId(list.id)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="bg-card border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="p-4 rounded-full bg-muted mb-4">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">
              No hay listas de difusión
            </h3>
            <p className="text-sm text-muted-foreground text-center mb-4 max-w-sm">
              Crea tu primera lista para enviar mensajes masivos a grupos de contactos
            </p>
            <Button onClick={() => { setSelectedListId(null); setIsEditorOpen(true); }}>
              <Plus className="h-4 w-4 mr-2" />
              Crear Lista
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Editor Dialog */}
      <BroadcastListEditor
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
        listId={selectedListId}
      />

      {/* Composer Dialog */}
      <BroadcastComposer
        open={isComposerOpen}
        onOpenChange={setIsComposerOpen}
        listId={selectedListId}
      />

      {/* History Panel */}
      <BroadcastHistoryPanel
        open={showHistory}
        onOpenChange={setShowHistory}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteListId} onOpenChange={() => setDeleteListId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar lista?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer. Se eliminará la lista y todo su historial de envíos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
