import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Mail,
  Phone,
  MessageCircle,
  ExternalLink,
  Crown,
  AlertTriangle,
  Calendar,
  DollarSign,
  CreditCard,
  CheckCircle2,
  XCircle,
  Play,
  ArrowUpCircle,
  Copy,
  Check,
  Loader2,
  FileText,
} from 'lucide-react';
import { openWhatsApp, getRecoveryMessage, getGreetingMessage } from './RecoveryTable';
import { useToast } from '@/hooks/use-toast';
import type { Client } from '@/hooks/useClients';

interface CustomerDrawerProps {
  client: Client | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  debtAmount?: number;
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof Play }> = {
  trialing: { label: 'En Trial', color: 'text-blue-400 bg-blue-500/10 border-blue-500/30', icon: Play },
  active: { label: 'Activo', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle2 },
  past_due: { label: 'Pago Vencido', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30', icon: AlertTriangle },
  canceled: { label: 'Cancelado', color: 'text-red-400 bg-red-500/10 border-red-500/30', icon: XCircle },
  customer: { label: 'Cliente', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle2 },
  lead: { label: 'Lead', color: 'text-gray-400 bg-gray-500/10 border-gray-500/30', icon: Play },
  churn: { label: 'Churn', color: 'text-red-400 bg-red-500/10 border-red-500/30', icon: XCircle },
  trial: { label: 'Trial', color: 'text-blue-400 bg-blue-500/10 border-blue-500/30', icon: Play },
};

const eventIcons: Record<string, { icon: typeof Mail; color: string }> = {
  email_open: { icon: Mail, color: 'text-blue-400' },
  email_click: { icon: ExternalLink, color: 'text-cyan-400' },
  payment_failed: { icon: CreditCard, color: 'text-red-400' },
  payment_success: { icon: CheckCircle2, color: 'text-emerald-400' },
  trial_started: { icon: Play, color: 'text-blue-400' },
  trial_converted: { icon: ArrowUpCircle, color: 'text-emerald-400' },
};

export function CustomerDrawer({ client, open, onOpenChange, debtAmount = 0 }: CustomerDrawerProps) {
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const { toast } = useToast();

  // Fetch client events
  const { data: events } = useQuery({
    queryKey: ['client-events', client?.id],
    queryFn: async () => {
      if (!client?.id) return [];
      const { data, error } = await supabase
        .from('client_events')
        .select('*')
        .eq('client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
    enabled: open && !!client?.id,
  });

  // Fetch lead events for attribution timeline
  const { data: leadEvents } = useQuery({
    queryKey: ['lead-events', client?.id],
    queryFn: async () => {
      if (!client?.id) return [];
      const { data, error } = await supabase
        .from('lead_events')
        .select('*')
        .eq('client_id', client.id)
        .order('processed_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data;
    },
    enabled: open && !!client?.id,
  });

  // Fetch client transactions
  const { data: transactions } = useQuery({
    queryKey: ['client-transactions', client?.email],
    queryFn: async () => {
      if (!client?.email) return [];
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('customer_email', client.email)
        .order('stripe_created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data;
    },
    enabled: open && !!client?.email,
  });

  // Fetch client invoices
  const { data: invoices } = useQuery({
    queryKey: ['client-invoices', client?.stripe_customer_id],
    queryFn: async () => {
      if (!client?.stripe_customer_id) return [];
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('stripe_customer_id', client.stripe_customer_id)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data;
    },
    enabled: open && !!client?.stripe_customer_id,
  });

  if (!client) return null;

  const handlePortalLink = async () => {
    if (!client.stripe_customer_id) {
      toast({ title: 'Sin Stripe ID', variant: 'destructive' });
      return;
    }
    setLoadingPortal(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-portal-session', {
        body: { stripe_customer_id: client.stripe_customer_id, return_url: window.location.origin },
      });
      if (error) throw error;
      if (data?.url) {
        await navigator.clipboard.writeText(data.url);
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
        toast({ title: 'Link copiado al portapapeles' });
      }
    } catch (error) {
      toast({ title: 'Error generando link', variant: 'destructive' });
    } finally {
      setLoadingPortal(false);
    }
  };

  const handleWhatsApp = () => {
    if (!client.phone) return;
    const message = debtAmount > 0
      ? getRecoveryMessage(client.full_name || '', debtAmount)
      : getGreetingMessage(client.full_name || '');
    openWhatsApp(client.phone, client.full_name || '', message);
  };

  const lifecycleStage = client.lifecycle_stage?.toLowerCase() || 'lead';
  const status = statusConfig[lifecycleStage] || statusConfig.lead;
  const StatusIcon = status.icon;
  const totalSpendUSD = (client.total_spend || 0) / 100;
  const isVip = totalSpendUSD >= 1000;

  // Combine timeline data
  const timelineItems = [
    // Registration
    client.created_at && {
      type: 'registration',
      date: client.created_at,
      label: 'Registro',
      icon: Calendar,
      color: 'text-blue-400',
    },
    // First seen (lead)
    client.first_seen_at && client.first_seen_at !== client.created_at && {
      type: 'lead',
      date: client.first_seen_at,
      label: `Lead desde ${client.acquisition_source || 'desconocido'}`,
      icon: Play,
      color: 'text-cyan-400',
    },
    // Trial started
    client.trial_started_at && {
      type: 'trial',
      date: client.trial_started_at,
      label: 'Inicio de Trial',
      icon: Play,
      color: 'text-purple-400',
    },
    // Conversion
    client.converted_at && {
      type: 'conversion',
      date: client.converted_at,
      label: 'Conversión a Pago',
      icon: ArrowUpCircle,
      color: 'text-emerald-400',
    },
    // Lead events
    ...(leadEvents?.map((e) => ({
      type: 'lead_event',
      date: e.processed_at,
      label: `${e.event_type} (${e.source})`,
      icon: Play,
      color: 'text-cyan-400',
    })) || []),
    // Events
    ...(events?.map((e) => ({
      type: 'event',
      date: e.created_at,
      label: e.event_type.replace(/_/g, ' '),
      icon: eventIcons[e.event_type]?.icon || Mail,
      color: eventIcons[e.event_type]?.color || 'text-gray-400',
      metadata: e.metadata,
    })) || []),
    // Transactions
    ...(transactions?.map((t) => ({
      type: 'transaction',
      date: t.stripe_created_at || t.created_at,
      label: t.status === 'paid' || t.status === 'succeeded' ? 'Pago exitoso' : t.status === 'failed' ? 'Pago fallido' : t.status,
      icon: t.status === 'failed' ? CreditCard : CheckCircle2,
      color: t.status === 'failed' ? 'text-red-400' : 'text-emerald-400',
      amount: t.amount / 100,
      currency: t.currency,
    })) || []),
  ].filter(Boolean).sort((a, b) => new Date(b!.date).getTime() - new Date(a!.date).getTime());

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg bg-card border-border">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-3">
            <div className={`flex h-12 w-12 items-center justify-center rounded-full ${isVip ? 'bg-yellow-500/20' : 'bg-primary/10'}`}>
              <span className={`text-lg font-medium ${isVip ? 'text-yellow-500' : 'text-primary'}`}>
                {client.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || '??'}
              </span>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-foreground">{client.full_name || 'Sin nombre'}</span>
                {isVip && <Crown className="h-4 w-4 text-yellow-500" />}
              </div>
              <Badge variant="outline" className={`text-xs ${status.color}`}>
                <StatusIcon className="h-3 w-3 mr-1" />
                {status.label}
              </Badge>
            </div>
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-200px)] pr-4">
          {/* Contact Info */}
          <div className="space-y-3 mb-6">
            <h3 className="text-sm font-medium text-muted-foreground">Datos de Contacto</h3>
            <div className="space-y-2 rounded-lg border border-border/50 bg-background/50 p-3">
              {client.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-foreground">{client.email}</span>
                </div>
              )}
              {client.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="text-foreground">{client.phone}</span>
                </div>
              )}
              {!client.email && !client.phone && (
                <p className="text-sm text-muted-foreground">Sin datos de contacto</p>
              )}
            </div>
          </div>

          {/* Attribution Info */}
          {(client.acquisition_source || client.utm_source || client.utm_campaign) && (
            <div className="space-y-3 mb-6">
              <h3 className="text-sm font-medium text-muted-foreground">Atribución</h3>
              <div className="space-y-2 rounded-lg border border-border/50 bg-background/50 p-3">
                {client.acquisition_source && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Fuente:</span>
                    <Badge variant="outline">{client.acquisition_source}</Badge>
                  </div>
                )}
                {client.utm_source && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">UTM Source:</span>
                    <span className="text-foreground">{client.utm_source}</span>
                  </div>
                )}
                {client.utm_campaign && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Campaign:</span>
                    <span className="text-foreground">{client.utm_campaign}</span>
                  </div>
                )}
                {client.utm_medium && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Medium:</span>
                    <span className="text-foreground">{client.utm_medium}</span>
                  </div>
                )}
                {client.first_seen_at && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Primera vez:</span>
                    <span className="text-foreground">
                      {format(new Date(client.first_seen_at), 'd MMM yyyy', { locale: es })}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-center">
              <DollarSign className="h-5 w-5 mx-auto text-emerald-400 mb-1" />
              <p className={`text-lg font-bold ${isVip ? 'text-yellow-400' : 'text-foreground'}`}>
                ${totalSpendUSD.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">LTV</p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/50 p-3 text-center">
              <CreditCard className="h-5 w-5 mx-auto text-blue-400 mb-1" />
              <p className="text-lg font-bold text-foreground">{transactions?.filter(t => t.status === 'paid' || t.status === 'succeeded').length || 0}</p>
              <p className="text-xs text-muted-foreground">Pagos</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2 mb-6">
            <Button
              onClick={handleWhatsApp}
              disabled={!client.phone}
              className="flex-1 gap-2 bg-[#25D366] hover:bg-[#1da851]"
              size="sm"
            >
              <MessageCircle className="h-4 w-4" />
              WhatsApp
            </Button>
            <Button
              onClick={handlePortalLink}
              disabled={!client.stripe_customer_id || loadingPortal}
              variant="outline"
              className="flex-1 gap-2"
              size="sm"
            >
              {loadingPortal ? <Loader2 className="h-4 w-4 animate-spin" /> : copiedLink ? <Check className="h-4 w-4" /> : <ExternalLink className="h-4 w-4" />}
              Portal Stripe
            </Button>
          </div>

          {/* Pending Invoices */}
          {invoices && invoices.filter(i => i.status === 'open' || i.status === 'draft').length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Facturas Pendientes
              </h3>
              <div className="space-y-2">
                {invoices.filter(i => i.status === 'open' || i.status === 'draft').map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between p-2 rounded-lg border border-amber-500/30 bg-amber-500/10">
                    <span className="text-sm text-amber-400">${(inv.amount_due / 100).toFixed(2)}</span>
                    {inv.hosted_invoice_url && (
                      <Button size="sm" variant="ghost" className="h-6 gap-1 text-xs" onClick={() => window.open(inv.hosted_invoice_url!, '_blank')}>
                        Ver <ExternalLink className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator className="my-4" />

          {/* Timeline */}
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Timeline de Actividad</h3>
          <div className="relative">
            <div className="absolute left-4 top-2 bottom-2 w-px bg-border/50" />
            <div className="space-y-3">
              {timelineItems.slice(0, 15).map((item, idx) => {
                if (!item) return null;
                const Icon = item.icon;
                return (
                  <div key={idx} className="relative pl-10">
                    <div className={`absolute left-0 flex h-8 w-8 items-center justify-center rounded-full bg-card border border-border ${idx === 0 ? 'ring-2 ring-primary/30' : ''}`}>
                      <Icon className={`h-4 w-4 ${item.color}`} />
                    </div>
                    <div className="rounded-lg bg-background/50 border border-border/30 p-2">
                      <div className="flex items-center justify-between">
                        <span className={`text-sm font-medium capitalize ${item.color}`}>{item.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(item.date), 'd MMM HH:mm', { locale: es })}
                        </span>
                      </div>
                      {'amount' in item && typeof item.amount === 'number' && (
                        <p className="text-xs text-muted-foreground mt-1">
                          ${item.amount.toFixed(2)} {('currency' in item && item.currency) ? String(item.currency).toUpperCase() : ''}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              {timelineItems.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Sin actividad registrada</p>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
