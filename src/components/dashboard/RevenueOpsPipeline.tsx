import { useState, useEffect, useMemo } from 'react';
import { 
  DollarSign, AlertTriangle, Clock, UserX, MessageCircle, 
  Smartphone, MessageSquare, ExternalLink, Send, CheckCircle, 
  RefreshCw, TrendingUp, Zap, Phone
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
import { supabase } from '@/integrations/supabase/client';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';
import { openWhatsApp, openNativeSms } from './RecoveryTable';
import { supportsNativeSms } from '@/lib/nativeSms';

interface PipelineClient {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  revenue_score: number;
  total_spend: number | null;
  lifecycle_stage: string | null;
  pipeline_type: 'recovery' | 'trial_expiring' | 'winback';
  revenue_at_risk: number;
  days_until_action: number;
  last_campaign_status: string | null;
  campaign_count: number;
}

interface CampaignMetrics {
  total_sent: number;
  total_delivered: number;
  total_replied: number;
  total_converted: number;
  recovery_rate: number;
  trial_conversion_rate: number;
  revenue_recovered: number;
}

const pipelineConfig = {
  recovery: { 
    label: 'Recuperación', 
    shortLabel: 'Recovery',
    icon: AlertTriangle, 
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30'
  },
  trial_expiring: { 
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
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/30'
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

type DateRange = '1d' | '7d' | '30d' | '90d' | 'all';

const dateRangeConfig: Record<DateRange, { label: string; shortLabel: string; days: number | null }> = {
  '1d': { label: '1 día', shortLabel: '1d', days: 1 },
  '7d': { label: '7 días', shortLabel: '7d', days: 7 },
  '30d': { label: '30 días', shortLabel: '30d', days: 30 },
  '90d': { label: '90 días', shortLabel: '90d', days: 90 },
  'all': { label: 'Todo', shortLabel: 'All', days: null },
};

export function RevenueOpsPipeline() {
  const [activeTab, setActiveTab] = useState<'recovery' | 'trial_expiring' | 'winback'>('recovery');
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [clients, setClients] = useState<PipelineClient[]>([]);
  const [metrics, setMetrics] = useState<CampaignMetrics>({
    total_sent: 0, total_delivered: 0, total_replied: 0, 
    total_converted: 0, recovery_rate: 0, trial_conversion_rate: 0, revenue_recovered: 0
  });
  const [loading, setLoading] = useState(true);
  const [showOnlyWithPhone, setShowOnlyWithPhone] = useState(false);

  const getDateFilter = () => {
    const days = dateRangeConfig[dateRange].days;
    if (days === null) return null;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  };

  const loadData = async () => {
    setLoading(true);
    const dateFilter = getDateFilter();
    try {
      // Load campaign metrics
      let executionsQuery = supabase
        .from('campaign_executions')
        .select('status, revenue_at_risk, trigger_event');
      if (dateFilter) {
        executionsQuery = executionsQuery.gte('created_at', dateFilter);
      }
      const { data: executions } = await executionsQuery;

      if (executions) {
        const sent = executions.filter(e => e.status !== 'pending').length;
        const delivered = executions.filter(e => ['delivered', 'replied', 'converted'].includes(e.status)).length;
        const replied = executions.filter(e => ['replied', 'converted'].includes(e.status)).length;
        const converted = executions.filter(e => e.status === 'converted').length;
        const recoveryConverted = executions.filter(e => e.status === 'converted' && e.trigger_event === 'payment_failed').length;
        const recoveryTotal = executions.filter(e => e.trigger_event === 'payment_failed').length;
        const trialConverted = executions.filter(e => e.status === 'converted' && e.trigger_event.includes('trial')).length;
        const trialTotal = executions.filter(e => e.trigger_event.includes('trial')).length;
        const revenueRecovered = executions
          .filter(e => e.status === 'converted')
          .reduce((sum, e) => sum + (e.revenue_at_risk || 0), 0);

        setMetrics({
          total_sent: sent,
          total_delivered: delivered,
          total_replied: replied,
          total_converted: converted,
          recovery_rate: recoveryTotal > 0 ? (recoveryConverted / recoveryTotal) * 100 : 0,
          trial_conversion_rate: trialTotal > 0 ? (trialConverted / trialTotal) * 100 : 0,
          revenue_recovered: revenueRecovered / 100,
        });
      }

      // Load failed transactions for recovery
      let failedTxQuery = supabase
        .from('transactions')
        .select('customer_email, amount')
        .eq('status', 'failed');
      if (dateFilter) {
        failedTxQuery = failedTxQuery.gte('created_at', dateFilter);
      }
      const { data: failedTx } = await failedTxQuery;

      // Load clients with their data
      const { data: clientsData } = await supabase
        .from('clients')
        .select('*')
        .order('revenue_score', { ascending: false });

      // Load subscriptions for trials
      const { data: subs } = await supabase
        .from('subscriptions')
        .select('customer_email, trial_end, status, amount')
        .eq('status', 'trialing');

      // Load campaign executions for each client
      const { data: clientCampaigns } = await supabase
        .from('campaign_executions')
        .select('client_id, status')
        .order('created_at', { ascending: false });

      const campaignsByClient = (clientCampaigns || []).reduce((acc, c) => {
        if (!acc[c.client_id]) acc[c.client_id] = [];
        acc[c.client_id].push(c);
        return acc;
      }, {} as Record<string, typeof clientCampaigns>);

      // Build pipeline clients
      const pipelineClients: PipelineClient[] = [];

      // Recovery clients (failed payments)
      const failedByEmail = (failedTx || []).reduce((acc, tx) => {
        if (tx.customer_email) {
          if (!acc[tx.customer_email]) acc[tx.customer_email] = 0;
          acc[tx.customer_email] += tx.amount;
        }
        return acc;
      }, {} as Record<string, number>);

      (clientsData || []).forEach(client => {
        const clientCampaignList = campaignsByClient[client.id] || [];
        const lastCampaign = clientCampaignList[0];

        // Check if recovery needed
        if (client.email && failedByEmail[client.email]) {
          pipelineClients.push({
            id: client.id,
            email: client.email,
            full_name: client.full_name,
            phone: client.phone,
            revenue_score: client.revenue_score || 0,
            total_spend: client.total_spend,
            lifecycle_stage: client.lifecycle_stage,
            pipeline_type: 'recovery',
            revenue_at_risk: failedByEmail[client.email] / 100,
            days_until_action: 0,
            last_campaign_status: lastCampaign?.status || null,
            campaign_count: clientCampaignList.length,
          });
        }

        // Check if trial expiring
        const clientSub = (subs || []).find(s => s.customer_email === client.email);
        if (clientSub?.trial_end) {
          const trialEnd = new Date(clientSub.trial_end);
          const daysLeft = Math.ceil((trialEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          if (daysLeft <= 3 && daysLeft >= 0) {
            pipelineClients.push({
              id: client.id,
              email: client.email,
              full_name: client.full_name,
              phone: client.phone,
              revenue_score: client.revenue_score || 0,
              total_spend: client.total_spend,
              lifecycle_stage: client.lifecycle_stage,
              pipeline_type: 'trial_expiring',
              revenue_at_risk: (clientSub.amount || 0) / 100,
              days_until_action: daysLeft,
              last_campaign_status: lastCampaign?.status || null,
              campaign_count: clientCampaignList.length,
            });
          }
        }

        // Check if winback needed
        if (client.lifecycle_stage === 'CHURN') {
          pipelineClients.push({
            id: client.id,
            email: client.email,
            full_name: client.full_name,
            phone: client.phone,
            revenue_score: client.revenue_score || 0,
            total_spend: client.total_spend,
            lifecycle_stage: client.lifecycle_stage,
            pipeline_type: 'winback',
            revenue_at_risk: (client.total_spend || 0) / 100,
            days_until_action: 0,
            last_campaign_status: lastCampaign?.status || null,
            campaign_count: clientCampaignList.length,
          });
        }
      });

      setClients(pipelineClients);
    } catch (error) {
      console.error('Error loading pipeline data:', error);
      toast.error('Error cargando datos del pipeline');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [dateRange]);

  const filteredClients = useMemo(() => {
    let result = clients.filter(c => c.pipeline_type === activeTab);
    if (showOnlyWithPhone) {
      result = result.filter(c => c.phone);
    }
    return result.sort((a, b) => b.revenue_at_risk - a.revenue_at_risk);
  }, [clients, activeTab, showOnlyWithPhone]);

  const pipelineCounts = useMemo(() => ({
    recovery: clients.filter(c => c.pipeline_type === 'recovery').length,
    trial_expiring: clients.filter(c => c.pipeline_type === 'trial_expiring').length,
    winback: clients.filter(c => c.pipeline_type === 'winback').length,
  }), [clients]);

  const totalRevenueAtRisk = useMemo(() => 
    filteredClients.reduce((sum, c) => sum + c.revenue_at_risk, 0),
  [filteredClients]);

  // Action handlers
  const handleWhatsApp = (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    const message = messageTemplates[template](client.full_name || '', client.revenue_at_risk);
    openWhatsApp(client.phone, client.full_name || '', message);
    toast.success('WhatsApp abierto');
  };

  const handleNativeSms = (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    const message = messageTemplates[template](client.full_name || '', client.revenue_at_risk);
    openNativeSms(client.phone, message);
  };

  const handleSMS = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    toast.loading('Enviando SMS...', { id: 'sms' });
    try {
      await invokeWithAdminKey('send-sms', {
        to: client.phone,
        template,
        client_name: client.full_name,
        amount: Math.round(client.revenue_at_risk * 100),
        client_id: client.id,
      });
      toast.success('SMS enviado', { id: 'sms' });
      loadData();
    } catch (error: any) {
      toast.error('Error: ' + error.message, { id: 'sms' });
    }
  };

  const handleManyChat = async (client: PipelineClient, template: 'friendly' | 'urgent' | 'final') => {
    toast.loading('Enviando por ManyChat...', { id: 'manychat' });
    try {
      const data = await invokeWithAdminKey<{ error?: string }>('send-manychat', {
        email: client.email,
        phone: client.phone,
        template,
        client_name: client.full_name,
        amount: Math.round(client.revenue_at_risk * 100),
        client_id: client.id,
        tag: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial_expiring' ? 'trial_expiring' : 'winback',
      });
      if (data?.error) {
        toast.error(data.error, { id: 'manychat' });
      } else {
        toast.success('Mensaje ManyChat enviado', { id: 'manychat' });
        loadData();
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
        phone: client.phone,
        name: client.full_name,
        tag: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial_expiring' ? 'trial_expiring' : 'winback',
        message_data: { revenue_at_risk: client.revenue_at_risk * 100 }
      });
      toast.success('Oportunidad creada en GHL', { id: 'ghl' });
      loadData();
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
      trigger_event: activeTab === 'recovery' ? 'payment_failed' : activeTab === 'trial_expiring' ? 'trial_end_24h' : 'canceled',
      status: 'converted',
      revenue_at_risk: client.revenue_at_risk * 100,
    });
    toast.success('Marcado como convertido');
    loadData();
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-6 w-6 md:h-8 md:w-8 text-amber-500 shrink-0" />
          <div>
            <h1 className="text-lg md:text-2xl font-bold text-white">Revenue Ops</h1>
            <p className="text-[10px] md:text-sm text-muted-foreground hidden sm:block">
              Centro de operaciones multicanal
            </p>
          </div>
        </div>
        
        {/* Date Range + Refresh - Compact on mobile */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/50 rounded-lg p-0.5 overflow-x-auto">
            {(Object.entries(dateRangeConfig) as [DateRange, typeof dateRangeConfig['1d']][]).map(([key, config]) => (
              <Button
                key={key}
                variant={dateRange === key ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDateRange(key)}
                className={`text-[10px] md:text-xs px-2 md:px-3 h-7 ${dateRange === key ? 'bg-primary text-primary-foreground' : ''}`}
              >
                <span className="md:hidden">{config.shortLabel}</span>
                <span className="hidden md:inline">{config.label}</span>
              </Button>
            ))}
          </div>
          <Button onClick={loadData} variant="outline" size="sm" className="h-7 w-7 p-0 md:w-auto md:px-3 md:gap-2">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden md:inline">Actualizar</span>
          </Button>
        </div>
      </div>

      {/* Metrics Cards - 2x2 on mobile */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <Card className="bg-card border-border/50">
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Send className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Enviados</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-white">{metrics.total_sent}</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-emerald-400 mb-1">
              <CheckCircle className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Conversiones</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-emerald-400">{metrics.total_converted}</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-1">
              <TrendingUp className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Trial→Paid</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-blue-400">{metrics.trial_conversion_rate.toFixed(0)}%</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border/50">
          <CardContent className="p-3 md:p-4">
            <div className="flex items-center gap-2 text-green-400 mb-1">
              <DollarSign className="h-3 w-3 md:h-4 md:w-4" />
              <span className="text-[10px] md:text-xs">Recuperado</span>
            </div>
            <p className="text-lg md:text-2xl font-bold text-green-400">
              ${metrics.revenue_recovered.toFixed(0)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline Tabs - Horizontal scroll on mobile */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
            <TabsList className="bg-muted/50 w-max">
              {(Object.entries(pipelineConfig) as [keyof typeof pipelineConfig, typeof pipelineConfig.recovery][]).map(([key, config]) => {
                const Icon = config.icon;
                return (
                  <TabsTrigger key={key} value={key} className="gap-1.5 px-2 md:px-3 text-xs md:text-sm whitespace-nowrap">
                    <Icon className={`h-3 w-3 md:h-4 md:w-4 ${config.color}`} />
                    <span className="hidden sm:inline">{config.label}</span>
                    <span className="sm:hidden">{config.shortLabel}</span>
                    <Badge variant="secondary" className="ml-0.5 text-[10px] h-4 px-1">{pipelineCounts[key]}</Badge>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="phone-filter-pipeline"
                checked={showOnlyWithPhone}
                onCheckedChange={setShowOnlyWithPhone}
                className="scale-90"
              />
              <Label htmlFor="phone-filter-pipeline" className="text-[10px] md:text-xs cursor-pointer whitespace-nowrap">
                Con tel
              </Label>
            </div>
            <div className="text-right">
              <p className="text-sm md:text-lg font-bold text-red-400">
                ${totalRevenueAtRisk.toFixed(0)}
              </p>
              <p className="text-[10px] text-muted-foreground">En riesgo</p>
            </div>
          </div>
        </div>

        <TabsContent value={activeTab} className="mt-3 md:mt-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 md:h-64">
              <RefreshCw className="h-6 w-6 md:h-8 md:w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredClients.length === 0 ? (
            <div className="rounded-xl border border-border/50 bg-card p-8 md:p-12 text-center">
              <CheckCircle className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-3 text-emerald-500/50" />
              <p className="text-sm text-muted-foreground mb-1">¡Pipeline vacío!</p>
              <p className="text-xs text-muted-foreground">No hay clientes pendientes</p>
            </div>
          ) : (
            <>
              {/* Mobile Cards View */}
              <div className="md:hidden space-y-2">
                {filteredClients.map((client) => (
                  <div key={`${client.id}-${client.pipeline_type}`} className="rounded-lg border border-border/50 bg-card p-3">
                    {/* Row 1: Name + Amount */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate text-foreground">
                          {client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">{client.email}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-sm font-bold text-red-400">${client.revenue_at_risk.toFixed(0)}</span>
                        {activeTab === 'trial_expiring' && (
                          <p className="text-[10px] text-amber-400">{client.days_until_action}d</p>
                        )}
                      </div>
                    </div>
                    
                    {/* Row 2: Score + Status */}
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex items-center gap-1.5 flex-1">
                        <Progress value={Math.min(client.revenue_score * 10, 100)} className="w-12 h-1.5" />
                        <span className="text-[10px] text-muted-foreground">{client.revenue_score}</span>
                      </div>
                      {client.last_campaign_status ? (
                        <Badge 
                          variant="outline" 
                          className={`text-[10px] h-4 px-1 ${
                            client.last_campaign_status === 'converted' ? 'text-emerald-400 border-emerald-500/30' :
                            client.last_campaign_status === 'sent' ? 'text-blue-400 border-blue-500/30' :
                            'text-muted-foreground'
                          }`}
                        >
                          {client.last_campaign_status}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-4 px-1 text-muted-foreground">Nuevo</Badge>
                      )}
                      {client.phone && (
                        <span className="text-[10px] text-muted-foreground/70 truncate max-w-[80px]">{client.phone}</span>
                      )}
                    </div>

                    {/* Row 3: Action Buttons - Horizontal */}
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                      {/* WhatsApp */}
                      {client.phone && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" className="h-7 px-2 shrink-0 bg-[#25D366] hover:bg-[#1da851] text-white text-[10px] gap-1">
                              <MessageCircle className="h-3 w-3" />
                              WA
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="bg-popover border-border">
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>🚨 Final</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {/* Native SMS (iOS) */}
                      {client.phone && supportsNativeSms() && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" className="h-7 px-2 shrink-0 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 text-[10px] gap-1">
                              <Smartphone className="h-3 w-3" />
                              SMS
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="bg-popover border-border">
                            <DropdownMenuItem onClick={() => handleNativeSms(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleNativeSms(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleNativeSms(client, 'final')}>🚨 Final</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {/* SMS API */}
                      {client.phone && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" className="h-7 px-2 shrink-0 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-[10px] gap-1">
                              <Phone className="h-3 w-3" />
                              API
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="bg-popover border-border">
                            <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>🚨 Final</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}

                      {/* ManyChat */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" className="h-7 px-2 shrink-0 bg-[#0084FF]/15 hover:bg-[#0084FF]/25 text-[#0084FF] text-[10px] gap-1">
                            <MessageSquare className="h-3 w-3" />
                            FB
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="center" className="bg-popover border-border">
                          <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleManyChat(client, 'final')}>🚨 Final</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {/* GHL */}
                      <Button 
                        size="sm"
                        onClick={() => handleGHL(client)}
                        className="h-7 px-2 shrink-0 bg-orange-500/15 hover:bg-orange-500/25 text-orange-400 text-[10px] gap-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        GHL
                      </Button>

                      {/* Stripe Portal */}
                      <Button 
                        size="sm"
                        onClick={() => handleStripePortal(client)}
                        className="h-7 px-2 shrink-0 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 text-[10px] gap-1"
                      >
                        <DollarSign className="h-3 w-3" />
                        $
                      </Button>

                      {/* Mark Converted */}
                      <Button 
                        size="sm"
                        onClick={() => markAsConverted(client)}
                        className="h-7 px-2 shrink-0 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[10px] gap-1"
                      >
                        <CheckCircle className="h-3 w-3" />
                        ✓
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block rounded-xl border border-border/50 bg-card overflow-hidden">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border/50 hover:bg-transparent">
                        <TableHead className="text-muted-foreground">Cliente</TableHead>
                        <TableHead className="text-muted-foreground">Score</TableHead>
                        <TableHead className="text-muted-foreground">En Riesgo</TableHead>
                        <TableHead className="text-muted-foreground">Estado</TableHead>
                        <TableHead className="text-muted-foreground">#</TableHead>
                        <TableHead className="text-right text-muted-foreground">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredClients.map((client) => (
                        <TableRow key={`${client.id}-${client.pipeline_type}`} className="border-border/50 hover:bg-muted/20">
                          <TableCell>
                            <div>
                              <p className="font-medium text-foreground">
                                {client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}
                              </p>
                              <p className="text-xs text-muted-foreground">{client.email}</p>
                              {client.phone && (
                                <p className="text-xs text-muted-foreground/70">{client.phone}</p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Progress value={Math.min(client.revenue_score * 10, 100)} className="w-16 h-2" />
                              <span className="text-sm font-medium">{client.revenue_score}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-red-400 font-semibold text-lg">
                              ${client.revenue_at_risk.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            </span>
                            {activeTab === 'trial_expiring' && (
                              <p className="text-xs text-amber-400">{client.days_until_action}d restantes</p>
                            )}
                          </TableCell>
                          <TableCell>
                            {client.last_campaign_status ? (
                              <Badge 
                                variant="outline" 
                                className={
                                  client.last_campaign_status === 'converted' ? 'text-emerald-400 border-emerald-500/30' :
                                  client.last_campaign_status === 'sent' ? 'text-blue-400 border-blue-500/30' :
                                  'text-muted-foreground'
                                }
                              >
                                {client.last_campaign_status}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">Sin contactar</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">{client.campaign_count}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1 flex-wrap">
                              {/* WhatsApp */}
                              {client.phone && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="icon" className="h-8 w-8 bg-[#25D366] hover:bg-[#1da851]">
                                      <MessageCircle className="h-4 w-4" />
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
                              )}

                              {/* SMS */}
                              {client.phone && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="icon" variant="outline" className="h-8 w-8 border-blue-500/30 text-blue-400">
                                      <Smartphone className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>
                                      😊 Amigable
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>
                                      ⚠️ Urgente
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>
                                      🚨 Final
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}

                              {/* ManyChat */}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button size="icon" variant="outline" className="h-8 w-8 border-[#0084FF]/30 text-[#0084FF]">
                                    <MessageSquare className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>
                                    😊 Amigable
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>
                                    ⚠️ Urgente
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleManyChat(client, 'final')}>
                                    🚨 Final
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>

                              {/* GHL */}
                              <Button 
                                size="icon" 
                                variant="outline" 
                                className="h-8 w-8 border-orange-500/30 text-orange-400"
                                onClick={() => handleGHL(client)}
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>

                              {/* Stripe Portal */}
                              <Button 
                                size="icon" 
                                variant="outline" 
                                className="h-8 w-8 border-purple-500/30 text-purple-400"
                                onClick={() => handleStripePortal(client)}
                              >
                                <DollarSign className="h-4 w-4" />
                              </Button>

                              {/* Mark Converted */}
                              <Button 
                                size="icon" 
                                variant="outline" 
                                className="h-8 w-8 border-emerald-500/30 text-emerald-400"
                                onClick={() => markAsConverted(client)}
                              >
                                <CheckCircle className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
