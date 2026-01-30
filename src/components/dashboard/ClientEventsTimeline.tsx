import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  Mail,
  MousePointerClick,
  AlertCircle,
  CreditCard,
  CheckCircle2,
  Activity,
  UserPlus,
  ArrowUpCircle,
  AlertTriangle,
  Headphones,
  LogIn,
  Circle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ClientEvent {
  id: string;
  client_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface ClientEventsTimelineProps {
  clientId: string;
  clientName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// VRP Style: Semantic colors only (emerald=success, amber=warning, red=error, zinc=neutral)
const eventConfig: Record<string, { icon: typeof Mail; color: string; label: string }> = {
  email_open: { icon: Mail, color: "text-zinc-400", label: "Abrió email" },           // Neutral
  email_click: { icon: MousePointerClick, color: "text-zinc-400", label: "Clic en email" }, // Neutral
  email_bounce: { icon: AlertCircle, color: "text-red-400", label: "Email rebotado" },      // Error
  email_sent: { icon: Mail, color: "text-zinc-400", label: "Email enviado" },         // Neutral
  payment_failed: { icon: CreditCard, color: "text-red-400", label: "Pago fallido" }, // Error
  payment_success: { icon: CheckCircle2, color: "text-emerald-400", label: "Pago exitoso" }, // Success
  high_usage: { icon: Activity, color: "text-zinc-400", label: "Uso alto" },          // Neutral
  trial_started: { icon: UserPlus, color: "text-amber-400", label: "Inició prueba" }, // Pending
  trial_converted: { icon: ArrowUpCircle, color: "text-emerald-400", label: "Convirtió de trial" }, // Success
  churn_risk: { icon: AlertTriangle, color: "text-amber-400", label: "Riesgo de fuga" }, // Warning
  support_ticket: { icon: Headphones, color: "text-zinc-400", label: "Ticket de soporte" }, // Neutral
  login: { icon: LogIn, color: "text-zinc-400", label: "Inicio de sesión" },          // Neutral
  custom: { icon: Circle, color: "text-zinc-400", label: "Evento personalizado" },    // Neutral
};

export function ClientEventsTimeline({ clientId, clientName, open, onOpenChange }: ClientEventsTimelineProps) {
  const { data: events, isLoading } = useQuery({
    queryKey: ["client-events", clientId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_events")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as ClientEvent[];
    },
    enabled: open && !!clientId,
  });

  const getEventConfig = (eventType: string) => {
    return eventConfig[eventType] || eventConfig.custom;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-card border-border/50">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Timeline de {clientName}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="h-[400px] pr-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : events && events.length > 0 ? (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-2 bottom-2 w-px bg-border/50" />

              <div className="space-y-4">
                {events.map((event, idx) => {
                  const config = getEventConfig(event.event_type);
                  const Icon = config.icon;

                  return (
                    <div key={event.id} className="relative pl-10">
                      {/* Icon */}
                      <div
                        className={cn(
                          "absolute left-0 flex h-8 w-8 items-center justify-center rounded-full bg-background border border-border",
                          idx === 0 && "ring-2 ring-primary/30"
                        )}
                      >
                        <Icon className={cn("h-4 w-4", config.color)} />
                      </div>

                      {/* Content */}
                      <div className="rounded-lg bg-background/50 border border-border/30 p-3">
                        <div className="flex items-center justify-between">
                          <span className={cn("font-medium text-sm", config.color)}>
                            {config.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(event.created_at), "d MMM, HH:mm", { locale: es })}
                          </span>
                        </div>
                        {event.metadata && Object.keys(event.metadata).length > 0 && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            {Object.entries(event.metadata).map(([key, value]) => (
                              <div key={key}>
                                <span className="text-foreground/70">{key}:</span>{" "}
                                {String(value)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <Activity className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>No hay eventos registrados</p>
              <p className="text-sm mt-1">Los eventos aparecerán aquí automáticamente</p>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
