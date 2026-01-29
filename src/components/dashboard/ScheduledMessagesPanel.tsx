import { format, formatDistanceToNow, isPast } from "date-fns";
import { es } from "date-fns/locale";
import { 
  usePendingScheduledMessages, 
  useCancelScheduledMessage,
  type ScheduledMessage 
} from "@/hooks/useScheduledMessages";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { 
  Clock, 
  X, 
  Image, 
  FileText, 
  Mic, 
  Video,
  Calendar,
  MessageSquare
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ScheduledMessagesPanelProps {
  contactId?: string;
  onSelectContact?: (contactId: string) => void;
}

function MediaIcon({ type }: { type: string | null }) {
  if (!type) return null;
  
  switch (type) {
    case "image":
      return <Image className="h-3 w-3" />;
    case "audio":
      return <Mic className="h-3 w-3" />;
    case "video":
      return <Video className="h-3 w-3" />;
    case "document":
      return <FileText className="h-3 w-3" />;
    default:
      return null;
  }
}

export function ScheduledMessagesPanel({ contactId, onSelectContact }: ScheduledMessagesPanelProps) {
  const { data: messages, isLoading } = usePendingScheduledMessages();
  const cancelMutation = useCancelScheduledMessage();

  // Filter by contact if provided
  const filteredMessages = contactId 
    ? messages?.filter(m => m.contact_id === contactId)
    : messages;

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!filteredMessages?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Calendar className="h-10 w-10 mb-3 opacity-50" />
        <p className="text-sm">No hay mensajes programados</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full max-h-[300px]">
      <div className="p-2 space-y-2">
        {filteredMessages.map((msg) => {
          const scheduledDate = new Date(msg.scheduled_at);
          const isOverdue = isPast(scheduledDate);
          
          return (
            <div
              key={msg.id}
              className={cn(
                "p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors",
                isOverdue && "border-yellow-500/50 bg-yellow-500/5"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {/* Time badge */}
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge 
                      variant={isOverdue ? "destructive" : "secondary"} 
                      className="gap-1 text-xs"
                    >
                      <Clock className="h-3 w-3" />
                      {format(scheduledDate, "d MMM, HH:mm", { locale: es })}
                    </Badge>
                    {msg.media_type && (
                      <Badge variant="outline" className="gap-1 text-xs">
                        <MediaIcon type={msg.media_type} />
                        {msg.media_type}
                      </Badge>
                    )}
                  </div>
                  
                  {/* Message preview */}
                  {msg.message && (
                    <p className="text-sm text-foreground line-clamp-2">
                      {msg.message}
                    </p>
                  )}
                  
                  {/* Contact ID (if not filtered) */}
                  {!contactId && (
                    <button
                      onClick={() => onSelectContact?.(msg.contact_id)}
                      className="text-xs text-primary hover:underline mt-1"
                    >
                      {msg.contact_id}
                    </button>
                  )}
                  
                  {/* Time until send */}
                  <p className="text-xs text-muted-foreground mt-1">
                    {isOverdue 
                      ? "Pendiente de envío..." 
                      : `En ${formatDistanceToNow(scheduledDate, { locale: es })}`
                    }
                  </p>
                </div>
                
                {/* Cancel button */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>¿Cancelar mensaje programado?</AlertDialogTitle>
                      <AlertDialogDescription>
                        El mensaje programado para {format(scheduledDate, "d 'de' MMMM 'a las' HH:mm", { locale: es })} será cancelado.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>No, mantener</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => cancelMutation.mutate(msg.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Sí, cancelar
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
