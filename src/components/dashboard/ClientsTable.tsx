import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { MoreHorizontal, Mail, Phone, MessageCircle, Activity, Link, Crown, AlertTriangle, Copy, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { openWhatsApp, getGreetingMessage, getRecoveryMessage } from "./RecoveryTable";
import { ClientEventsTimeline } from "./ClientEventsTimeline";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { Client } from "@/hooks/useClients";

interface ClientsTableProps {
  clients: Client[];
  isLoading?: boolean;
  onEdit?: (client: Client) => void;
  onDelete?: (id: string) => void;
  page?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  recoveryEmails?: Set<string>;
  recoveryAmounts?: Record<string, number>;
  vipOnly?: boolean;
  onVipOnlyChange?: (value: boolean) => void;
  isVip?: (client: Client) => boolean;
}

const VIP_THRESHOLD = 100000; // $1,000 USD in cents

const getStatusBadge = (status: string | null) => {
  const statusLower = status?.toLowerCase() || "unknown";
  
  const statusConfig: Record<string, { label: string; className: string }> = {
    active: { label: "Activo", className: "status-active" },
    pending: { label: "Pendiente", className: "status-pending" },
    inactive: { label: "Inactivo", className: "status-inactive" },
  };

  const config = statusConfig[statusLower] || { label: status || "Desconocido", className: "bg-muted text-muted-foreground" };

  return (
    <Badge variant="outline" className={cn("text-xs font-medium border", config.className)}>
      {config.label}
    </Badge>
  );
};

export function ClientsTable({ 
  clients, 
  isLoading, 
  onEdit, 
  onDelete, 
  page = 0, 
  totalPages = 1, 
  onPageChange,
  recoveryEmails = new Set(),
  recoveryAmounts = {},
  vipOnly = false,
  onVipOnlyChange,
  isVip = (client) => (client.total_spend || 0) >= VIP_THRESHOLD,
}: ClientsTableProps) {
  const [timelineClient, setTimelineClient] = useState<{ id: string; name: string } | null>(null);
  const [loadingPortal, setLoadingPortal] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { toast } = useToast();
  
  const handleWhatsAppClick = (client: Client) => {
    if (!client.phone) return;
    
    const isInRecovery = client.email && recoveryEmails.has(client.email);
    const debtAmount = client.email ? recoveryAmounts[client.email] || 0 : 0;
    
    const message = isInRecovery && debtAmount > 0
      ? getRecoveryMessage(client.full_name || '', debtAmount)
      : getGreetingMessage(client.full_name || '');
    
    openWhatsApp(client.phone, client.full_name || '', message);
  };

  const handlePortalLink = async (client: Client) => {
    if (!client.stripe_customer_id) {
      toast({
        title: "Sin ID de Stripe",
        description: "Este cliente no tiene un stripe_customer_id asociado.",
        variant: "destructive",
      });
      return;
    }

    setLoadingPortal(client.id);
    try {
      const { data, error } = await supabase.functions.invoke("create-portal-session", {
        body: { 
          stripe_customer_id: client.stripe_customer_id,
          return_url: window.location.origin
        },
      });

      if (error) throw error;

      if (data?.url) {
        await navigator.clipboard.writeText(data.url);
        setCopiedId(client.id);
        setTimeout(() => setCopiedId(null), 2000);
        toast({
          title: "Link copiado",
          description: "El link del portal de pagos se copió al portapapeles.",
        });
      }
    } catch (error) {
      console.error("Error creating portal session:", error);
      toast({
        title: "Error",
        description: "No se pudo generar el link del portal.",
        variant: "destructive",
      });
    } finally {
      setLoadingPortal(null);
    }
  };
  
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Cargando clientes...</p>
        </div>
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-8 text-center">
          <p className="text-muted-foreground">
            {vipOnly ? "No hay clientes VIP (>$1,000 USD)" : "No hay clientes registrados"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* VIP Filter */}
        {onVipOnlyChange && (
          <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-muted/20">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-yellow-500" />
              <Label htmlFor="vip-filter" className="text-sm font-medium cursor-pointer">
                Solo VIPs (LTV &gt; $1,000 USD)
              </Label>
            </div>
            <Switch
              id="vip-filter"
              checked={vipOnly}
              onCheckedChange={onVipOnlyChange}
            />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Cliente
                </th>
                <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  LTV
                </th>
                <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Contacto
                </th>
                <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Estado
                </th>
                <th className="px-6 py-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Última sincronización
                </th>
                <th className="px-6 py-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {clients.map((client) => {
                const isInRecovery = client.email && recoveryEmails.has(client.email);
                const clientIsVip = isVip(client);
                const totalSpendUSD = (client.total_spend || 0) / 100;
                
                return (
                  <tr
                    key={client.id}
                    className={cn(
                      "transition-colors hover:bg-muted/20",
                      clientIsVip && "bg-yellow-500/5"
                    )}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-full",
                          clientIsVip ? "bg-yellow-500/20" : "bg-primary/10"
                        )}>
                          <span className={cn(
                            "text-sm font-medium",
                            clientIsVip ? "text-yellow-500" : "text-primary"
                          )}>
                            {client.full_name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "??"}
                          </span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-foreground">{client.full_name || "Sin nombre"}</p>
                            {clientIsVip && (
                              <Tooltip>
                                <TooltipTrigger>
                                  <Crown className="h-4 w-4 text-yellow-500" />
                                </TooltipTrigger>
                                <TooltipContent>Cliente VIP - LTV: ${totalSpendUSD.toLocaleString()}</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            {client.is_delinquent && (
                              <Badge variant="outline" className="text-xs bg-red-500/10 text-red-400 border-red-500/30">
                                <AlertTriangle className="h-3 w-3 mr-1" />
                                Moroso
                              </Badge>
                            )}
                            {isInRecovery && !client.is_delinquent && (
                              <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-400 border-orange-500/30">
                                Pago fallido
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className={cn(
                          "font-semibold",
                          clientIsVip ? "text-yellow-400" : "text-foreground"
                        )}>
                          ${totalSpendUSD.toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground">USD lifetime</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        {client.email && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Mail className="h-3.5 w-3.5" />
                            {client.email}
                          </div>
                        )}
                        {client.phone && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Phone className="h-3.5 w-3.5" />
                            {client.phone}
                          </div>
                        )}
                        {!client.email && !client.phone && (
                          <span className="text-sm text-muted-foreground">Sin contacto</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(client.status)}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {client.last_sync
                        ? formatDistanceToNow(new Date(client.last_sync), {
                            addSuffix: true,
                            locale: es,
                          })
                        : "Nunca"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        {/* Portal Link Button */}
                        {client.stripe_customer_id && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                                onClick={() => handlePortalLink(client)}
                                disabled={loadingPortal === client.id}
                              >
                                {loadingPortal === client.id ? (
                                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                                ) : copiedId === client.id ? (
                                  <Check className="h-4 w-4 text-green-400" />
                                ) : (
                                  <Link className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Copiar link de portal de pagos</TooltipContent>
                          </Tooltip>
                        )}

                        {/* Timeline Button */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-primary/70 hover:text-primary hover:bg-primary/10"
                              onClick={() => setTimelineClient({ id: client.id, name: client.full_name || "Cliente" })}
                            >
                              <Activity className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Ver historial de eventos</TooltipContent>
                        </Tooltip>

                        {/* WhatsApp Button */}
                        {client.phone ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-[#25D366] hover:text-[#25D366] hover:bg-[#25D366]/10"
                                onClick={() => handleWhatsAppClick(client)}
                              >
                                <MessageCircle className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {isInRecovery ? "Enviar mensaje de cobro" : "Enviar saludo"}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground/30 cursor-not-allowed"
                                disabled
                              >
                                <MessageCircle className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Sin teléfono registrado</TooltipContent>
                          </Tooltip>
                        )}
                        
                        {/* Actions Menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onEdit?.(client)}>
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => onDelete?.(client.id)}
                            >
                              Eliminar
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        
        {/* Pagination */}
        {totalPages > 1 && onPageChange && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-border">
            <p className="text-sm text-muted-foreground">
              Página {page + 1} de {totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page - 1)}
                disabled={page === 0}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages - 1}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Client Events Timeline Dialog */}
      {timelineClient && (
        <ClientEventsTimeline
          clientId={timelineClient.id}
          clientName={timelineClient.name}
          open={!!timelineClient}
          onOpenChange={(open) => !open && setTimelineClient(null)}
        />
      )}
    </TooltipProvider>
  );
}
