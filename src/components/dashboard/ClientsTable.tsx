import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
import { MoreHorizontal, Mail, Phone, MessageCircle, Activity, Link, Crown, AlertTriangle, Check, Send, ChevronLeft, ChevronRight, Smartphone } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { openWhatsApp, openNativeSms, getGreetingMessage, getRecoveryMessage } from "./RecoveryTable";
import { supportsNativeSms } from "@/lib/nativeSms";
import { ClientEventsTimeline } from "./ClientEventsTimeline";

import { invokeWithAdminKey } from "@/lib/adminApi";
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

// Lifecycle stage badge
const getLifecycleBadge = (stage: string | null, isDelinquent?: boolean) => {
  if (isDelinquent) {
    return (
      <Badge variant="outline" className="text-[10px] md:text-xs font-medium border bg-red-500/10 text-red-400 border-red-500/30">
        <AlertTriangle className="h-2.5 w-2.5 md:h-3 md:w-3 mr-0.5 md:mr-1" />
        Moroso
      </Badge>
    );
  }

  const stageLower = stage?.toUpperCase() || "UNKNOWN";
  
  const stageConfig: Record<string, { label: string; className: string }> = {
    LEAD: { label: "Lead", className: "bg-gray-500/10 text-gray-400 border-gray-500/30" },
    TRIAL: { label: "Trial", className: "bg-purple-500/10 text-purple-400 border-purple-500/30" },
    CUSTOMER: { label: "Cliente", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
    CHURN: { label: "Cancel", className: "bg-red-500/10 text-red-400 border-red-500/30" },
  };

  const config = stageConfig[stageLower] || { label: stage || "?", className: "bg-muted text-muted-foreground" };

  return (
    <Badge variant="outline" className={cn("text-[10px] md:text-xs font-medium border", config.className)}>
      {config.label}
    </Badge>
  );
};

// Payment status badge
const getPaymentStatusBadge = (paymentStatus: string | null) => {
  if (!paymentStatus || paymentStatus === 'none') return null;
  
  const statusConfig: Record<string, { label: string; className: string }> = {
    active: { label: "Pagando", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
    past_due: { label: "Atrás", className: "bg-orange-500/10 text-orange-400 border-orange-500/30" },
    failed: { label: "Fallido", className: "bg-red-500/10 text-red-400 border-red-500/30" },
    canceled: { label: "Cancel", className: "bg-gray-500/10 text-gray-400 border-gray-500/30" },
  };

  const config = statusConfig[paymentStatus] || null;
  if (!config) return null;

  return (
    <Badge variant="outline" className={cn("text-[10px] md:text-xs font-medium border", config.className)}>
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
  const [sendingToCRM, setSendingToCRM] = useState<string | null>(null);
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

  const handleNativeSmsClick = (client: Client) => {
    if (!client.phone) return;
    
    const isInRecovery = client.email && recoveryEmails.has(client.email);
    const debtAmount = client.email ? recoveryAmounts[client.email] || 0 : 0;
    
    const message = isInRecovery && debtAmount > 0
      ? getRecoveryMessage(client.full_name || '', debtAmount)
      : getGreetingMessage(client.full_name || '');
    
    openNativeSms(client.phone, message);
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
      const data = await invokeWithAdminKey("create-portal-session", { 
        stripe_customer_id: client.stripe_customer_id,
        return_url: window.location.origin
      });

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

  const handleSendToCRM = async (client: Client) => {
    setSendingToCRM(client.id);
    try {
      await invokeWithAdminKey("notify-ghl", {
        email: client.email,
        phone: client.phone,
        name: client.full_name,
        tag: 'manual_push',
        message_data: {
          total_spend_cents: client.total_spend,
          lifecycle_stage: client.lifecycle_stage,
          is_vip: (client.total_spend || 0) >= VIP_THRESHOLD
        }
      });

      toast({
        title: "Enviado a CRM",
        description: `${client.full_name || client.email} fue enviado a GoHighLevel.`,
      });
    } catch (error) {
      console.error("Error sending to CRM:", error);
      toast({
        title: "Error",
        description: "No se pudo enviar al CRM.",
        variant: "destructive",
      });
    } finally {
      setSendingToCRM(null);
    }
  };
  
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 md:p-8 text-center">
          <div className="mx-auto h-6 w-6 md:h-8 md:w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="mt-3 md:mt-4 text-xs md:text-sm text-muted-foreground">Cargando...</p>
        </div>
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <div className="p-6 md:p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {vipOnly ? "No hay clientes VIP" : "No hay clientes"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {/* VIP Filter - Compact on mobile */}
        {onVipOnlyChange && (
          <div className="flex items-center justify-between px-3 md:px-6 py-2.5 md:py-3 border-b border-border bg-muted/20">
            <div className="flex items-center gap-1.5 md:gap-2">
              <Crown className="h-3.5 w-3.5 md:h-4 md:w-4 text-yellow-500" />
              <Label htmlFor="vip-filter" className="text-xs md:text-sm font-medium cursor-pointer">
                Solo VIPs
              </Label>
            </div>
            <Switch
              id="vip-filter"
              checked={vipOnly}
              onCheckedChange={onVipOnlyChange}
            />
          </div>
        )}

        {/* Mobile Card View */}
        <div className="md:hidden divide-y divide-border">
          {clients.map((client) => {
            const isInRecovery = client.email && recoveryEmails.has(client.email);
            const clientIsVip = isVip(client);
            const totalSpendUSD = (client.total_spend || 0) / 100;
            
            return (
              <div 
                key={client.id} 
                className={cn(
                  "p-3 touch-feedback",
                  clientIsVip && "bg-yellow-500/5"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  {/* Left: Avatar + Info */}
                  <div className="flex items-start gap-2.5 flex-1 min-w-0">
                    <div className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full shrink-0",
                      clientIsVip ? "bg-yellow-500/20" : "bg-primary/10"
                    )}>
                      <span className={cn(
                        "text-xs font-medium",
                        clientIsVip ? "text-yellow-500" : "text-primary"
                      )}>
                        {client.full_name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "??"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-medium text-sm text-foreground truncate max-w-[140px]">
                          {client.full_name || "Sin nombre"}
                        </p>
                        {clientIsVip && <Crown className="h-3 w-3 text-yellow-500 shrink-0" />}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {client.email || "Sin email"}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {getLifecycleBadge(client.lifecycle_stage, client.is_delinquent)}
                        {getPaymentStatusBadge(client.payment_status)}
                        {isInRecovery && !client.is_delinquent && (
                          <Badge variant="outline" className="text-[10px] bg-orange-500/10 text-orange-400 border-orange-500/30">
                            Fallo
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: LTV + Actions */}
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <span className={cn(
                      "text-sm font-semibold",
                      clientIsVip ? "text-yellow-400" : "text-foreground"
                    )}>
                      ${totalSpendUSD.toLocaleString()}
                    </span>
                    <div className="flex items-center gap-1">
                      {client.phone && supportsNativeSms() && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-blue-400"
                          onClick={() => handleNativeSmsClick(client)}
                        >
                          <Smartphone className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {client.phone && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-[#25D366]"
                          onClick={() => handleWhatsAppClick(client)}
                        >
                          <MessageCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-primary/70"
                        onClick={() => setTimelineClient({ id: client.id, name: client.full_name || "Cliente" })}
                      >
                        <Activity className="h-3.5 w-3.5" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-popover border-border">
                          {client.stripe_customer_id && (
                            <DropdownMenuItem onClick={() => handlePortalLink(client)}>
                              <Link className="h-4 w-4 mr-2" />
                              Copiar portal
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem 
                            onClick={() => handleSendToCRM(client)}
                            disabled={!client.email}
                          >
                            <Send className="h-4 w-4 mr-2" />
                            Enviar a CRM
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
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
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop Table View */}
        <div className="hidden md:block overflow-x-auto">
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
                  Última sync
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
                                <TooltipContent>VIP - ${totalSpendUSD.toLocaleString()}</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          {(client.is_delinquent || isInRecovery) && (
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
                          )}
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
                        <span className="text-xs text-muted-foreground">USD</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="space-y-1">
                        {client.email && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Mail className="h-3.5 w-3.5" />
                            <span className="truncate max-w-[180px]">{client.email}</span>
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
                      <div className="flex flex-col gap-1">
                        {getLifecycleBadge(client.lifecycle_stage, client.is_delinquent)}
                        {getPaymentStatusBadge(client.payment_status)}
                      </div>
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
                            <TooltipContent>Copiar link portal</TooltipContent>
                          </Tooltip>
                        )}

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
                          <TooltipContent>Ver historial</TooltipContent>
                        </Tooltip>

                        {client.phone && supportsNativeSms() && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-blue-400 hover:text-blue-400 hover:bg-blue-400/10"
                                onClick={() => handleNativeSmsClick(client)}
                              >
                                <Smartphone className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              SMS Nativo
                            </TooltipContent>
                          </Tooltip>
                        )}

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
                              {isInRecovery ? "WhatsApp cobro" : "WhatsApp saludo"}
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
                            <TooltipContent>Sin teléfono</TooltipContent>
                          </Tooltip>
                        )}
                        
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="bg-popover border-border">
                            <DropdownMenuItem 
                              onClick={() => handleSendToCRM(client)}
                              disabled={!client.email || sendingToCRM === client.id}
                            >
                              {sendingToCRM === client.id ? (
                                <div className="h-4 w-4 mr-2 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                              ) : (
                                <Send className="h-4 w-4 mr-2" />
                              )}
                              Enviar a CRM
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
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
        
        {/* Pagination - Compact on mobile */}
        {totalPages > 1 && onPageChange && (
          <div className="flex items-center justify-between px-3 md:px-6 py-3 md:py-4 border-t border-border">
            <p className="text-xs md:text-sm text-muted-foreground">
              {page + 1}/{totalPages}
            </p>
            <div className="flex gap-1.5 md:gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page - 1)}
                disabled={page === 0}
                className="h-8 px-2 md:px-3"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="hidden sm:inline ml-1">Anterior</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages - 1}
                className="h-8 px-2 md:px-3"
              >
                <span className="hidden sm:inline mr-1">Siguiente</span>
                <ChevronRight className="h-4 w-4" />
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
