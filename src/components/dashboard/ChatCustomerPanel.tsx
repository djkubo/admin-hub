import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign,
  CreditCard,
  Crown,
  Mail,
  Phone,
  ExternalLink,
  MessageCircle,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Play,
  XCircle,
  Loader2,
  Check,
} from "lucide-react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useState } from "react";
import { invokeWithAdminKey } from "@/lib/adminApi";
import { useToast } from "@/hooks/use-toast";
import { openWhatsApp, getGreetingMessage } from "./RecoveryTable";

interface ChatCustomerPanelProps {
  clientId: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof Play }> = {
  trialing: { label: "Trial", color: "text-blue-400 bg-blue-500/10 border-blue-500/30", icon: Play },
  active: { label: "Activo", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", icon: CheckCircle2 },
  past_due: { label: "Moroso", color: "text-amber-400 bg-amber-500/10 border-amber-500/30", icon: AlertTriangle },
  canceled: { label: "Cancelado", color: "text-red-400 bg-red-500/10 border-red-500/30", icon: XCircle },
  customer: { label: "Cliente", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30", icon: CheckCircle2 },
  lead: { label: "Lead", color: "text-gray-400 bg-gray-500/10 border-gray-500/30", icon: Play },
  churn: { label: "Churn", color: "text-red-400 bg-red-500/10 border-red-500/30", icon: XCircle },
  trial: { label: "Trial", color: "text-blue-400 bg-blue-500/10 border-blue-500/30", icon: Play },
};

export function ChatCustomerPanel({ clientId, clientPhone, clientEmail }: ChatCustomerPanelProps) {
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const { toast } = useToast();

  // Fetch client by ID or by phone/email
  const { data: client, isLoading: loadingClient } = useQuery({
    queryKey: ["chat-customer", clientId, clientPhone, clientEmail],
    queryFn: async () => {
      let query = supabase.from("clients").select("*");
      
      if (clientId) {
        query = query.eq("id", clientId);
      } else if (clientEmail) {
        query = query.eq("email", clientEmail);
      } else if (clientPhone) {
        // Try both phone formats
        query = query.or(`phone.eq.${clientPhone},phone_e164.eq.${clientPhone}`);
      } else {
        return null;
      }
      
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!(clientId || clientPhone || clientEmail),
  });

  // Fetch transactions for LTV
  const { data: transactions } = useQuery({
    queryKey: ["chat-customer-transactions", client?.email],
    queryFn: async () => {
      if (!client?.email) return [];
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("customer_email", client.email)
        .in("status", ["paid", "succeeded"]);
      if (error) throw error;
      return data;
    },
    enabled: !!client?.email,
  });

  // Fetch active subscription
  const { data: subscription } = useQuery({
    queryKey: ["chat-customer-subscription", client?.email],
    queryFn: async () => {
      if (!client?.email) return null;
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("customer_email", client.email)
        .in("status", ["active", "trialing", "past_due"])
        .order("current_period_end", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!client?.email,
  });

  if (!clientId && !clientPhone && !clientEmail) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        <p>Selecciona un chat para ver el perfil</p>
      </div>
    );
  }

  if (loadingClient) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm p-4">
        <AlertTriangle className="h-8 w-8 mb-2 text-amber-500" />
        <p className="text-center">Cliente no encontrado en CRM</p>
        <p className="text-xs text-center mt-1">
          {clientEmail || clientPhone || "Sin datos"}
        </p>
      </div>
    );
  }

  const calculatedLtv = transactions?.reduce((sum, tx) => sum + (tx.amount || 0), 0) || 0;
  const totalSpendUSD = (calculatedLtv > 0 ? calculatedLtv : (client.total_spend || 0)) / 100;
  const isVip = totalSpendUSD >= 1000;
  const lifecycleStage = client.lifecycle_stage?.toLowerCase() || "lead";
  const status = statusConfig[lifecycleStage] || statusConfig.lead;
  const StatusIcon = status.icon;

  const handlePortalLink = async () => {
    if (!client.stripe_customer_id) {
      toast({ title: "Sin Stripe ID", variant: "destructive" });
      return;
    }
    setLoadingPortal(true);
    try {
      const data = await invokeWithAdminKey<{ url?: string }>("create-portal-session", {
        stripe_customer_id: client.stripe_customer_id,
        return_url: window.location.origin,
      });
      if (data?.url) {
        await navigator.clipboard.writeText(data.url);
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
        toast({ title: "Link copiado" });
      }
    } catch {
      toast({ title: "Error", variant: "destructive" });
    } finally {
      setLoadingPortal(false);
    }
  };

  const handleWhatsApp = () => {
    if (!client.phone) return;
    openWhatsApp(client.phone, client.full_name || "", getGreetingMessage(client.full_name || ""));
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className={`flex h-12 w-12 items-center justify-center rounded-full shrink-0 ${isVip ? "bg-yellow-500/20" : "bg-primary/10"}`}>
            <span className={`text-lg font-medium ${isVip ? "text-yellow-500" : "text-primary"}`}>
              {client.full_name?.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() || "??"}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-medium truncate">{client.full_name || "Sin nombre"}</span>
              {isVip && <Crown className="h-4 w-4 text-yellow-500 shrink-0" />}
            </div>
            <Badge variant="outline" className={`text-xs ${status.color}`}>
              <StatusIcon className="h-3 w-3 mr-1" />
              {status.label}
            </Badge>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-center">
            <DollarSign className="h-4 w-4 mx-auto text-emerald-400 mb-1" />
            <p className={`text-lg font-bold ${isVip ? "text-yellow-400" : "text-foreground"}`}>
              ${totalSpendUSD.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">LTV</p>
          </div>
          <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-center">
            <CreditCard className="h-4 w-4 mx-auto text-blue-400 mb-1" />
            <p className="text-lg font-bold">{transactions?.length || 0}</p>
            <p className="text-xs text-muted-foreground">Pagos</p>
          </div>
        </div>

        {/* Active Subscription */}
        {subscription && (
          <div className="rounded-lg border border-border/50 bg-background/50 p-3">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Plan Activo</span>
            </div>
            <p className="text-sm font-medium">{subscription.plan_name}</p>
            <p className="text-xs text-muted-foreground">
              ${(subscription.amount / 100).toFixed(0)}/{subscription.interval === "month" ? "mes" : "año"}
            </p>
            {subscription.current_period_end && (
              <p className="text-xs text-muted-foreground mt-1">
                Renueva: {format(new Date(subscription.current_period_end), "d MMM", { locale: es })}
              </p>
            )}
          </div>
        )}

        {/* Contact Info */}
        <div className="rounded-lg border border-border/50 bg-background/50 p-3 space-y-2">
          {client.email && (
            <div className="flex items-center gap-2 text-sm">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span className="truncate">{client.email}</span>
            </div>
          )}
          {client.phone && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span>{client.phone}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={handleWhatsApp}
            disabled={!client.phone}
            size="sm"
            className="flex-1 gap-1.5 bg-[#25D366] hover:bg-[#1da851]"
          >
            <MessageCircle className="h-4 w-4" />
            WA
          </Button>
          <Button
            onClick={handlePortalLink}
            disabled={!client.stripe_customer_id || loadingPortal}
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
          >
            {loadingPortal ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : copiedLink ? (
              <Check className="h-4 w-4" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            Portal
          </Button>
        </div>

        {/* Attribution */}
        {(client.acquisition_source || client.utm_source) && (
          <div className="rounded-lg border border-border/50 bg-background/50 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">Atribución</p>
            <div className="space-y-1 text-xs">
              {client.acquisition_source && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fuente:</span>
                  <Badge variant="outline" className="text-xs">{client.acquisition_source}</Badge>
                </div>
              )}
              {client.utm_source && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">UTM:</span>
                  <span>{client.utm_source}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
