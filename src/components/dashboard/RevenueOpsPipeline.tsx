import { useState, useMemo } from 'react';
import { 
  DollarSign, AlertTriangle, Clock, UserX, MessageCircle, 
  Smartphone, MessageSquare, ExternalLink, Send, CheckCircle, 
  RefreshCw, TrendingUp, Zap, Phone, ChevronLeft, ChevronRight, Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';
import { openWhatsApp, openNativeSms } from './RecoveryTable';
import { supportsNativeSms } from '@/lib/nativeSms';
import { useRevenuePipeline, PipelineClient, PipelineType } from '@/hooks/useRevenuePipeline';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

const pipelineConfig = {
  recovery: { 
    label: 'Recuperación', 
    shortLabel: 'Recovery',
    icon: AlertTriangle, 
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30'
  },
  trial: { 
    label: 'Trials por Vencer', 
    shortLabel: 'Trials',
    icon: Clock, 
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30'
  },
  winback: { 
    label: 'Winback', 
    shortLabel: 'Winback',
    icon: UserX, 
    color: 'text-white',
    bgColor: 'bg-zinc-800',
    borderColor: 'border-zinc-700'
  },
};

const messageTemplates = {
  friendly: (name: string, amount: number) => 
    `Hola ${name || 'usuario'} 👋 Notamos que hubo un problemita con tu pago de $${amount.toFixed(2)}. ¿Te podemos ayudar?`,
  urgent: (name: string, amount: number) => 
    `${name || 'Usuario'}, tu pago de $${amount.toFixed(2)} está pendiente. Para evitar la suspensión, actualiza tu método de pago.`,
  final: (name: string, amount: number) => 
    `🚨 ÚLTIMO AVISO ${name || 'usuario'}: Servicio será suspendido en 24h por falta de pago ($${amount.toFixed(2)}).`,
};

const PAGE_SIZE_OPTIONS = [25, 50, 100];

export function RevenueOpsPipeline() {
  const [activeTab, setActiveTab] = useState<PipelineType>('recovery');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [showOnlyWithPhone, setShowOnlyWithPhone] = useState(false);

  // Server-side data fetching with pagination
  const { data, isLoading, refetch, isFetching } = useRevenuePipeline({
    type: activeTab,
    page,
    pageSize,
    showOnlyWithPhone,
  });

  const clients = data?.items || [];
  const summary = data?.summary;
  const totalCount = data?.pagination?.total || 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  // Reset page when tab changes
  const handleTabChange = (tab: string) => {
    setActiveTab(tab as PipelineType);
    setPage(1);
  };

  // Action handlers with event logging
  const logClientEvent = async (clientId: string, action: string, metadata: Record<string, unknown>) => {
    try {
      await supabase.from('client_events').insert({
        client_id: clientId,
        event_type: 'custom',
        metadata: { 
          action,
          source: 'dashboard_manual',
          timestamp: new Date().toISOString(),
          ...metadata 
        },
      });
    } catch (e) {
      console.error('Error logging event:', e);
    }
  };

  const handleWhatsApp = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    const phone = client.phone_e164 || client.phone;
    if (!phone) return;
    const message = messageTemplates[template](client.full_name || '', client.revenue_at_risk);
    openWhatsApp(phone, client.full_name || '', message);
    
    // Log event to prevent bot spam
    await logClientEvent(client.id, 'whatsapp_sent', {
      template,
      pipeline_type: activeTab,
      revenue_at_risk: client.revenue_at_risk,
    });
    
    toast.success('WhatsApp abierto');
  };

  const handleNativeSms = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    const phone = client.phone_e164 || client.phone;
    if (!phone) return;
    const message = messageTemplates[template](client.full_name || '', client.revenue_at_risk);
    openNativeSms(phone, message);
    
    await logClientEvent(client.id, 'sms_native_sent', {
      template,
      pipeline_type: activeTab,
    });
  };

  const handleSMS = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    const phone = client.phone_e164 || client.phone;
    if (!phone) return;
    toast.loading('Enviando SMS...', { id: 'sms' });
    try {
      await invokeWithAdminKey('send-sms', {
        to: phone,
        template,
        client_name: client.full_name,
        amount: Math.round(client.revenue_at_risk * 100),
        client_id: client.id,
      });
      
      await logClientEvent(client.id, 'sms_api_sent', {
        template,
        pipeline_type: activeTab,
        revenue_at_risk: client.revenue_at_risk,
      });
      
      toast.success('SMS enviado', { id: 'sms' });
      refetch();
    } catch (error: any) {
      toast.error('Error: ' + error.message, { id: 'sms' });
    }
  };

  const handleManyChat = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    toast.loading('Enviando por ManyChat...', { id: 'manychat' });
    try {
      const data = await invokeWithAdminKey<{ error?: string }>('send-manychat', {
        email: client.email,
        phone: client.phone_e164 || client.phone,
        template,
        client_name: client.full_name,
        amount: Math.round(client.revenue_at_risk * 100),
        client_id: client.id,
        tag: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial' ? 'trial_expiring' : 'winback',
      });
      
      if (data?.error) {
        toast.error(data.error, { id: 'manychat' });
      } else {
        await logClientEvent(client.id, 'manychat_sent', {
          template,
          pipeline_type: activeTab,
        });
        toast.success('Mensaje ManyChat enviado', { id: 'manychat' });
        refetch();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error(message, { id: 'manychat' });
    }
  };

  const handleGHL = async (client: PipelineClient) => {
    toast.loading('Creando oportunidad en GHL...', { id: 'ghl' });
    try {
      await invokeWithAdminKey('notify-ghl', {
        email: client.email,
        phone: client.phone_e164 || client.phone,
        name: client.full_name,
        tag: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial' ? 'trial_expiring' : 'winback',
        message_data: { revenue_at_risk: client.revenue_at_risk * 100 }
      });
      
      await logClientEvent(client.id, 'ghl_opportunity_created', {
        pipeline_type: activeTab,
      });
      
      toast.success('Oportunidad creada en GHL', { id: 'ghl' });
      refetch();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error('Error: ' + message, { id: 'ghl' });
    }
  };

  const handleStripePortal = async (client: PipelineClient) => {
    if (!client.email) return;
    toast.loading('Creando link del portal...', { id: 'portal' });
    try {
      const data = await invokeWithAdminKey<{ url?: string }>('create-portal-session', { email: client.email });
      if (data?.url) {
        window.open(data.url, '_blank');
        await logClientEvent(client.id, 'portal_link_opened', {
          pipeline_type: activeTab,
        });
        toast.success('Portal abierto', { id: 'portal' });
      } else {
        toast.error('Error creando portal', { id: 'portal' });
      }
    } catch (error: unknown) {
      toast.error('Error creando portal', { id: 'portal' });
    }
  };

  const markAsConverted = async (client: PipelineClient) => {
    await supabase.from('campaign_executions').insert({
      client_id: client.id,
      trigger_event: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial' ? 'trial_end_24h' : 'canceled',
      status: 'converted',
      revenue_at_risk: client.revenue_at_risk * 100,
    });
    
    await logClientEvent(client.id, 'marked_converted', {
      pipeline_type: activeTab,
      revenue_at_risk: client.revenue_at_risk,
    });
    
    toast.success('Marcado como convertido');
    refetch();
  };

  // Bot status badge
  const getBotStatusBadge = (client: PipelineClient) => {
    if (!client.queue_status) return null;
    
    const statusMap: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
      pending: { label: 'Bot: Pendiente', variant: 'outline' },
      retry_scheduled: { label: `Bot: Reintento ${client.retry_at ? formatDistanceToNow(new Date(client.retry_at), { locale: es, addSuffix: true }) : ''}`, variant: 'secondary' },
      notified: { label: 'Bot: Notificado', variant: 'default' },
      recovered: { label: 'Bot: Recuperado', variant: 'default' },
      failed: { label: 'Bot: Fallido', variant: 'destructive' },
    };
    
    const status = statusMap[client.queue_status] || { label: client.queue_status, variant: 'outline' as const };
    return <Badge variant={status.variant} className="text-[10px]">{status.label}</Badge>;
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-6 w-6 md:h-8 md:w-8 text-primary shrink-0" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold text-white">Revenue Ops</h1>
            <p className="text-[10px] md:text-sm text-muted-foreground hidden sm:block">
              Centro de operaciones multicanal
            </p>
          </div>
        </div>
        
        <Button onClick={() => refetch()} variant="outline" size="sm" className="h-7 w-7 p-0 md:w-auto md:px-3 md:gap-2">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          <span className="hidden md:inline">Actualizar</span>
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <Card className={`bg-card border-border/50 ${activeTab === 'recovery' ? 'ring-2 ring-red-500/50' : ''}`}>
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <AlertTriangle className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Deuda Total</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-white">
              ${(summary?.total_debt || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-muted-foreground">{summary?.recovery_count || 0} clientes</p>
          </CardContent>
        </Card>

        <Card className={`bg-card border-border/50 ${activeTab === 'trial' ? 'ring-2 ring-amber-500/50' : ''}`}>
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-amber-400 mb-1">
              <Clock className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Trials Expirando</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-white">
              ${(summary?.total_trials_expiring || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-muted-foreground">{summary?.trial_count || 0} trials</p>
          </CardContent>
        </Card>

        <Card className={`bg-card border-border/50 ${activeTab === 'winback' ? 'ring-2 ring-zinc-500/50' : ''}`}>
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-white mb-1">
              <UserX className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Winback</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-white">
              ${(summary?.total_winback || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
            <p className="text-[10px] text-muted-foreground">{summary?.winback_count || 0} churned</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs + Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="bg-muted/50">
            {(Object.entries(pipelineConfig) as [PipelineType, typeof pipelineConfig['recovery']][]).map(([key, config]) => {
              const Icon = config.icon;
              const count = key === 'recovery' ? summary?.recovery_count : key === 'trial' ? summary?.trial_count : summary?.winback_count;
              return (
                <TabsTrigger key={key} value={key} className="gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{config.shortLabel}</span>
                  <Badge variant="secondary" className="ml-1 text-[10px] px-1.5">
                    {count || 0}
                  </Badge>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="phone-only"
              checked={showOnlyWithPhone}
              onCheckedChange={setShowOnlyWithPhone}
            />
            <Label htmlFor="phone-only" className="text-xs cursor-pointer">
              Con tel
            </Label>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : clients.length === 0 ? (
          <div className="p-8 md:p-12 text-center">
            <CheckCircle className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-3 text-emerald-500/50" />
            <p className="text-sm text-muted-foreground mb-1">¡Sin casos pendientes!</p>
            <p className="text-xs text-muted-foreground">Los clientes aparecerán aquí cuando haya acciones disponibles</p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50">
                    <TableHead className="text-xs">Cliente</TableHead>
                    <TableHead className="text-xs text-right">En Riesgo</TableHead>
                    <TableHead className="text-xs">Estado Bot</TableHead>
                    <TableHead className="text-xs">Último Contacto</TableHead>
                    <TableHead className="text-xs text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clients.map((client) => (
                    <TableRow key={client.id} className="border-border/30 hover:bg-muted/30">
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm text-white truncate max-w-[200px]">
                            {client.full_name || client.email || 'Sin nombre'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {client.email}
                          </p>
                          {(client.phone || client.phone_e164) && (
                            <p className="text-xs text-muted-foreground">
                              {client.phone_e164 || client.phone}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-bold text-red-400">
                          ${client.revenue_at_risk.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </span>
                        {activeTab === 'trial' && client.days_until_expiry !== undefined && (
                          <p className="text-[10px] text-amber-400">
                            {client.days_until_expiry <= 0 ? 'Hoy' : `${Math.ceil(client.days_until_expiry)}d restantes`}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {getBotStatusBadge(client)}
                        {client.attempt_count && client.attempt_count > 0 && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {client.attempt_count} intentos
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {client.last_contact_at ? (
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(client.last_contact_at), { locale: es, addSuffix: true })}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* WhatsApp */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-7 w-7 p-0"
                                disabled={!client.phone && !client.phone_e164}
                              >
                                <MessageCircle className="h-3.5 w-3.5 text-green-500" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>
                                😊 Amigable
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>
                                ⚠️ Urgente
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>
                                🚨 Final
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          {/* SMS */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-7 w-7 p-0"
                                disabled={!client.phone && !client.phone_e164}
                              >
                                <Smartphone className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>
                                📱 API: Amigable
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>
                                📱 API: Urgente
                              </DropdownMenuItem>
                              {supportsNativeSms() && (
                                <DropdownMenuItem onClick={() => handleNativeSms(client, 'friendly')}>
                                  📲 Nativo: Amigable
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>

                          {/* ManyChat */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                <MessageSquare className="h-3.5 w-3.5 text-blue-500" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>
                                😊 Amigable
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>
                                ⚠️ Urgente
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          {/* Portal */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleStripePortal(client)}
                            disabled={!client.email}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>

                          {/* Mark Converted */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-emerald-500 hover:text-emerald-400"
                            onClick={() => markAsConverted(client)}
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden space-y-2 p-2">
              {clients.map((client) => (
                <div key={client.id} className="rounded-lg border border-border/30 bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {client.full_name || client.email || 'Sin nombre'}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{client.email}</p>
                    </div>
                    <span className="font-bold text-red-400 shrink-0">
                      ${client.revenue_at_risk.toFixed(2)}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 mb-2">
                    {getBotStatusBadge(client)}
                    {client.last_contact_at && (
                      <span className="text-[10px] text-muted-foreground">
                        Contactado {formatDistanceToNow(new Date(client.last_contact_at), { locale: es, addSuffix: true })}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 text-xs gap-1"
                      onClick={() => handleWhatsApp(client, 'friendly')}
                      disabled={!client.phone && !client.phone_e164}
                    >
                      <MessageCircle className="h-3 w-3 text-green-500" />
                      WA
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 text-xs gap-1"
                      onClick={() => handleSMS(client, 'friendly')}
                      disabled={!client.phone && !client.phone_e164}
                    >
                      <Smartphone className="h-3 w-3" />
                      SMS
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 text-xs gap-1"
                      onClick={() => handleStripePortal(client)}
                      disabled={!client.email}
                    >
                      <ExternalLink className="h-3 w-3" />
                      Portal
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-7 p-0 text-emerald-500"
                      onClick={() => markAsConverted(client)}
                    >
                      <CheckCircle className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Mostrar:</span>
            <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
              <SelectTrigger className="h-8 w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={size.toString()}>{size}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || isFetching}
            >
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              Página {page} de {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || isFetching}
            >
              Siguiente
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <span className="text-xs text-muted-foreground">
            {totalCount} total
          </span>
        </div>
      )}
    </div>
  );
}
