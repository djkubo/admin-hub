import React from 'react';
import { Clock, CheckCircle, XCircle, Send, AlertCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useBroadcastHistory } from '@/hooks/useBroadcastLists';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface BroadcastHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId?: string;
}

const STATUS_CONFIG = {
  pending: { label: 'Pendiente', icon: Clock, color: 'text-yellow-500', badge: 'secondary' },
  sending: { label: 'Enviando', icon: RefreshCw, color: 'text-blue-500', badge: 'default' },
  completed: { label: 'Completado', icon: CheckCircle, color: 'text-green-500', badge: 'default' },
  failed: { label: 'Fallido', icon: XCircle, color: 'text-red-500', badge: 'destructive' },
} as const;

export function BroadcastHistoryPanel({ open, onOpenChange, listId }: BroadcastHistoryPanelProps) {
  const { data: history, isLoading, refetch } = useBroadcastHistory(listId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <div className="flex items-center justify-between">
            <SheetTitle>Historial de Difusiones</SheetTitle>
            <Button variant="ghost" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <SheetDescription>
            Revisa el estado de los mensajes enviados
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-150px)] mt-4 pr-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : history && history.length > 0 ? (
            <div className="space-y-4">
              {history.map((broadcast) => {
                const status = STATUS_CONFIG[broadcast.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.pending;
                const StatusIcon = status.icon;
                const progress = broadcast.total_recipients > 0
                  ? ((broadcast.sent_count || 0) / broadcast.total_recipients) * 100
                  : 0;

                return (
                  <div
                    key={broadcast.id}
                    className="p-4 rounded-lg border bg-card space-y-3"
                  >
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={`h-4 w-4 ${status.color}`} />
                        <Badge variant={status.badge as any}>{status.label}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(broadcast.created_at), "d MMM yyyy, HH:mm", { locale: es })}
                      </span>
                    </div>

                    {/* Message Preview */}
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {broadcast.message_content}
                    </p>

                    {/* Progress */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Progreso</span>
                        <span>
                          {broadcast.sent_count || 0} / {broadcast.total_recipients || 0}
                        </span>
                      </div>
                      <Progress value={progress} className="h-2" />
                    </div>

                    {/* Stats */}
                    <div className="flex gap-4 text-xs">
                      <div className="flex items-center gap-1">
                        <Send className="h-3 w-3 text-green-500" />
                        <span>{broadcast.sent_count || 0} enviados</span>
                      </div>
                      {(broadcast.failed_count || 0) > 0 && (
                        <div className="flex items-center gap-1">
                          <AlertCircle className="h-3 w-3 text-red-500" />
                          <span>{broadcast.failed_count} fallidos</span>
                        </div>
                      )}
                    </div>

                    {/* Scheduled */}
                    {broadcast.scheduled_at && broadcast.status === 'pending' && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          Programado para {format(new Date(broadcast.scheduled_at), "d MMM, HH:mm", { locale: es })}
                        </span>
                      </div>
                    )}

                    {/* Completion time */}
                    {broadcast.completed_at && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle className="h-3 w-3" />
                        <span>
                          Completado {format(new Date(broadcast.completed_at), "d MMM, HH:mm", { locale: es })}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="p-4 rounded-full bg-muted mb-4">
                <Send className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-2">Sin historial</h3>
              <p className="text-sm text-muted-foreground">
                Aún no se han enviado difusiones
              </p>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
