import { useState, useMemo, useEffect } from 'react';
import { MessageCircle, Phone, AlertTriangle, CheckCircle, XCircle, Clock, Send, Smartphone, MessagesSquare, Link2, Play, Loader2, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { openWhatsApp, openNativeSms } from './RecoveryTable';
import { supportsNativeSms } from '@/lib/nativeSms';
import { useMetrics } from '@/hooks/useMetrics';
import { supabase } from '@/integrations/supabase/client';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import type { RecoveryClient } from '@/lib/csvProcessor';

type RecoveryStage = 'pending' | 'contacted' | 'paid' | 'lost';

const messageTemplatesWithLink = {
  friendly: (name: string, amount: number, link?: string) => 
    `Hola ${name || 'usuario'} 👋 Notamos que hubo un problemita con tu pago de $${amount.toFixed(2)}. ${link ? `Actualiza tu tarjeta aquí: ${link}` : '¿Te podemos ayudar a resolverlo?'}`,
  urgent: (name: string, amount: number, link?: string) => 
    `Hola ${name || 'usuario'}, tu pago de $${amount.toFixed(2)} no pudo procesarse y tu suscripción está en riesgo. ${link ? `Actualiza tu método de pago: ${link}` : 'Por favor actualiza tu método de pago lo antes posible.'}`,
  final: (name: string, amount: number, link?: string) => 
    `🚨 Último aviso: ${name || 'usuario'}, tu cuenta será suspendida en 24h por falta de pago ($${amount.toFixed(2)}). ${link ? `Actualiza tu tarjeta ahora: ${link}` : 'Contáctanos urgentemente.'}`,
};

// VRP Style: Semantic colors for stages (amber/green/red allowed for status meaning)
const stageConfig: Record<RecoveryStage, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: 'Pendiente', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: Clock },
  contacted: { label: 'Contactado', color: 'bg-zinc-800 text-white border-zinc-700', icon: Send },
  paid: { label: 'Pagó', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: CheckCircle },
  lost: { label: 'Perdido', color: 'bg-red-500/10 text-red-400 border-red-500/30', icon: XCircle },
};

export function RecoveryPage() {
  const { metrics } = useMetrics();
  const [stages, setStages] = useState<Record<string, RecoveryStage>>({});
  const [showOnlyWithPhone, setShowOnlyWithPhone] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'stripe' | 'paypal'>('all');
  const [lastContactDates, setLastContactDates] = useState<Record<string, string>>({});
  const [portalLinks, setPortalLinks] = useState<Record<string, string>>({});
  const [generatingLink, setGeneratingLink] = useState<string | null>(null);
  const [runningDunning, setRunningDunning] = useState(false);
  const [savingStage, setSavingStage] = useState<string | null>(null);

  const getStage = (email: string): RecoveryStage => stages[email] || 'pending';

  // Initialize stages from saved recovery_status in database
  useEffect(() => {
    if (metrics.recoveryList?.length) {
      const savedStages: Record<string, RecoveryStage> = {};
      for (const client of metrics.recoveryList) {
        if (client.recovery_status) {
          savedStages[client.email] = client.recovery_status;
        }
      }
      // Only update if we have saved stages to prevent overwriting local changes
      if (Object.keys(savedStages).length > 0) {
        setStages(prev => ({ ...savedStages, ...prev }));
      }
    }
  }, [metrics.recoveryList]);

  // Fetch last contact dates for all recovery clients
  useEffect(() => {
    const fetchLastContacts = async () => {
      if (!metrics.recoveryList?.length) return;

      const emails = metrics.recoveryList.map((c: RecoveryClient) => c.email);
      
      // Fetch last outbound message per email
      const { data: messages } = await supabase
        .from('messages')
        .select('to_address, created_at, metadata')
        .eq('direction', 'outbound')
        .order('created_at', { ascending: false });

      if (messages) {
        const dateMap: Record<string, string> = {};
        for (const client of metrics.recoveryList as RecoveryClient[]) {
          const phoneDigits = client.phone?.replace(/\D/g, '').slice(-10);
          const match = messages.find(m => 
            m.to_address?.includes(phoneDigits || 'NOMATCH') ||
            (m.metadata as Record<string, unknown>)?.customer_email === client.email
          );
          if (match) {
            dateMap[client.email] = match.created_at;
          }
        }
        setLastContactDates(dateMap);
      }
    };

    fetchLastContacts();
  }, [metrics.recoveryList]);

  const setStage = async (email: string, stage: RecoveryStage) => {
    // Optimistic update
    setStages(prev => ({ ...prev, [email]: stage }));
    setSavingStage(email);
    
    try {
      // Fetch client and current metadata
      const { data: client } = await supabase
        .from('clients')
        .select('id, customer_metadata')
        .eq('email', email)
        .single();
      
      if (client) {
        // Merge recovery_status into existing metadata
        const currentMetadata = (client.customer_metadata as Record<string, unknown>) || {};
        const updatedMetadata = {
          ...currentMetadata,
          recovery_status: stage,
          recovery_status_updated_at: new Date().toISOString(),
        };
        
        // Save to database
        const { error } = await supabase
          .from('clients')
          .update({ customer_metadata: updatedMetadata })
          .eq('id', client.id);
        
        if (error) throw error;
        
        // Log event
        await supabase.from('client_events').insert({
          client_id: client.id,
          event_type: 'custom',
          metadata: { action: 'recovery_stage_change', stage, timestamp: new Date().toISOString() },
        });
        
        toast.success(`Estado guardado: ${stageConfig[stage].label}`);
      } else {
        toast.warning('Cliente no encontrado en la base de datos');
      }
    } catch (e) {
      console.error('Error saving recovery status:', e);
      // Revert optimistic update on error
      setStages(prev => {
        const newStages = { ...prev };
        delete newStages[email];
        return newStages;
      });
      toast.error('Error guardando el estado');
    } finally {
      setSavingStage(null);
    }
  };

  // Generate portal link for a client
  const handleGeneratePortalLink = async (client: RecoveryClient) => {
    if (portalLinks[client.email]) {
      await navigator.clipboard.writeText(portalLinks[client.email]);
      toast.success('Link copiado al portapapeles');
      return;
    }

    setGeneratingLink(client.email);
    try {
      // First get the stripe_customer_id from clients table
      const { data: clientData } = await supabase
        .from('clients')
        .select('id, stripe_customer_id')
        .eq('email', client.email)
        .single();

      if (!clientData?.stripe_customer_id) {
        toast.error('Cliente sin Stripe ID - no se puede generar link');
        return;
      }

      const data = await invokeWithAdminKey('generate-payment-link', {
        stripe_customer_id: clientData.stripe_customer_id,
        client_id: clientData.id,
        customer_email: client.email,
        customer_name: client.full_name,
      });

      if (data?.url) {
        const url = data.url as string;
        setPortalLinks(prev => ({ ...prev, [client.email]: url }));
        await navigator.clipboard.writeText(url);
        toast.success('Link generado y copiado');
      } else {
        toast.error('Error generando link');
      }
    } catch (error: any) {
      toast.error('Error: ' + error.message);
    } finally {
      setGeneratingLink(null);
    }
  };

  // Run automated dunning
  const handleRunDunning = async () => {
    setRunningDunning(true);
    toast.loading('Ejecutando dunning automático...', { id: 'dunning' });

    try {
      const data = await invokeWithAdminKey('automated-dunning', {});
      
      if (data?.success) {
        toast.success(
          `Dunning completado: ${data.messaged} mensajes enviados, ${data.marked_for_call} para llamar`,
          { id: 'dunning' }
        );
      } else {
        toast.error(String(data?.error) || 'Error en dunning', { id: 'dunning' });
      }
    } catch (error: any) {
      toast.error('Error: ' + error.message, { id: 'dunning' });
    } finally {
      setRunningDunning(false);
    }
  };

  const handleWhatsApp = async (client: RecoveryClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    
    const link = portalLinks[client.email];
    const message = messageTemplatesWithLink[template](client.full_name || '', client.amount, link);
    openWhatsApp(client.phone, client.full_name || '', message);
    
    if (getStage(client.email) === 'pending') {
      setStage(client.email, 'contacted');
    }
  };

  const handleNativeSms = (client: RecoveryClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    
    const link = portalLinks[client.email];
    const message = messageTemplatesWithLink[template](client.full_name || '', client.amount, link);
    openNativeSms(client.phone, message);
    
    if (getStage(client.email) === 'pending') {
      setStage(client.email, 'contacted');
    }
  };

  const handleSMS = async (client: RecoveryClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    
    // Get client ID
    const { data: clientData } = await supabase
      .from('clients')
      .select('id')
      .eq('email', client.email)
      .single();

    toast.loading('Enviando SMS...', { id: 'sms-sending' });

    try {
      await invokeWithAdminKey('send-sms', {
        to: client.phone,
        template,
        client_name: client.full_name || 'Cliente',
        amount: Math.round(client.amount * 100),
        client_id: clientData?.id,
      });

      toast.success('SMS enviado correctamente', { id: 'sms-sending' });
      
      if (getStage(client.email) === 'pending') {
        setStage(client.email, 'contacted');
      }
    } catch (error: any) {
      toast.error('Error enviando SMS: ' + error.message, { id: 'sms-sending' });
    }
  };

  const handleManyChat = async (client: RecoveryClient, template: 'friendly' | 'urgent' | 'final') => {
    // Get client ID
    const { data: clientData } = await supabase
      .from('clients')
      .select('id')
      .eq('email', client.email)
      .single();

    toast.loading('Enviando mensaje por ManyChat...', { id: 'manychat-sending' });

    try {
      const data = await invokeWithAdminKey('send-manychat', {
        email: client.email,
        phone: client.phone,
        template,
        client_name: client.full_name || 'Cliente',
        amount: Math.round(client.amount * 100),
        client_id: clientData?.id,
        tag: 'payment_failed',
      });

      if (data?.error) {
        toast.error(data.error + (data.details ? ': ' + data.details : ''), { id: 'manychat-sending' });
        return;
      }

      toast.success('Mensaje ManyChat enviado', { id: 'manychat-sending' });
      
      if (getStage(client.email) === 'pending') {
        setStage(client.email, 'contacted');
      }
    } catch (error: any) {
      toast.error('Error enviando mensaje: ' + error.message, { id: 'manychat-sending' });
    }
  };

  const filteredClients = useMemo(() => {
    let clients = metrics.recoveryList;
    
    if (showOnlyWithPhone) {
      clients = clients.filter((c: RecoveryClient) => c.phone);
    }
    
    if (sourceFilter !== 'all') {
      clients = clients.filter((c: RecoveryClient) => c.source.toLowerCase() === sourceFilter);
    }
    
    // Sort by amount descending
    return clients.sort((a, b) => b.amount - a.amount);
  }, [metrics.recoveryList, showOnlyWithPhone, sourceFilter]);

  const totalDebt = filteredClients.reduce((sum, c) => sum + c.amount, 0);
  const stageCounts = {
    pending: filteredClients.filter((c: RecoveryClient) => getStage(c.email) === 'pending').length,
    contacted: filteredClients.filter((c: RecoveryClient) => getStage(c.email) === 'contacted').length,
    paid: filteredClients.filter((c: RecoveryClient) => getStage(c.email) === 'paid').length,
    lost: filteredClients.filter((c: RecoveryClient) => getStage(c.email) === 'lost').length,
  };

  return (
    <TooltipProvider>
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <AlertTriangle className="h-6 w-6 md:h-8 md:w-8 text-primary" />
            Recuperación
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            CRM para gestionar pagos fallidos
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Button
            onClick={handleRunDunning}
            disabled={runningDunning}
            className="gap-2 bg-primary hover:bg-primary/90 text-white"
          >
            {runningDunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {runningDunning ? 'Ejecutando...' : 'Auto-Dunning'}
          </Button>
          <div className="text-left sm:text-right">
            <p className="text-2xl md:text-3xl font-bold text-red-400">${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs md:text-sm text-muted-foreground">Deuda total</p>
          </div>
        </div>
      </div>

      {/* Stage Summary - 2x2 on mobile */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        {(Object.entries(stageConfig) as [RecoveryStage, typeof stageConfig.pending][]).map(([stage, config]) => {
          const Icon = config.icon;
          return (
            <div key={stage} className={`rounded-xl border p-3 md:p-4 text-center ${config.color} touch-feedback`}>
              <Icon className="h-5 w-5 md:h-6 md:w-6 mx-auto mb-1 md:mb-2" />
              <p className="text-xl md:text-2xl font-bold">{stageCounts[stage]}</p>
              <p className="text-xs md:text-sm">{config.label}</p>
            </div>
          );
        })}
      </div>

      {/* Filters - Stack on mobile */}
      <div className="rounded-xl border border-border/50 bg-card p-3 md:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}>
            <TabsList className="bg-muted/50 h-8">
              <TabsTrigger value="all" className="text-xs px-3">Todos</TabsTrigger>
              <TabsTrigger value="stripe" className="text-xs px-3">Stripe</TabsTrigger>
              <TabsTrigger value="paypal" className="text-xs px-3">PayPal</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-3 justify-between sm:justify-end">
            <div className="flex items-center gap-2">
              <Switch
                id="phone-filter"
                checked={showOnlyWithPhone}
                onCheckedChange={setShowOnlyWithPhone}
              />
              <Label htmlFor="phone-filter" className="text-xs cursor-pointer">
                Con tel
              </Label>
            </div>
            <Badge variant="outline" className="text-muted-foreground text-xs">
              {filteredClients.length} clientes
            </Badge>
          </div>
        </div>
      </div>

      {/* Cards/Table - Use cards on mobile */}
      {filteredClients.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card p-8 md:p-12 text-center">
          <CheckCircle className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-sm text-muted-foreground mb-1">¡Sin pagos fallidos!</p>
          <p className="text-xs text-muted-foreground">Los clientes con pagos fallidos aparecerán aquí</p>
        </div>
      ) : (
        <>
          {/* Mobile Cards View */}
          <div className="md:hidden space-y-2">
            {filteredClients.map((client, index) => {
              const stage = getStage(client.email);
              const config = stageConfig[stage];
              const StageIcon = config.icon;

              return (
                <div key={index} className="rounded-lg border border-border/50 bg-card p-3">
                  {/* Row 1: Name + Amount */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-red-400">
                      ${client.amount.toFixed(0)}
                    </span>
                  </div>
                  
                  {/* Row 2: Email + Stage + Source */}
                  <div className="flex items-center gap-1 mb-2 overflow-x-auto">
                    <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{client.email}</p>
                    <span className="text-muted-foreground/30">•</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Badge variant="outline" className={`cursor-pointer text-[10px] px-1 h-4 shrink-0 ${config.color}`}>
                          {savingStage === client.email ? (
                            <Loader2 className="h-2 w-2 mr-0.5 animate-spin" />
                          ) : (
                            <StageIcon className="h-2 w-2 mr-0.5" />
                          )}
                          {config.label}
                        </Badge>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="bg-popover border-border">
                        {(Object.entries(stageConfig) as [RecoveryStage, typeof stageConfig.pending][]).map(([s, c]) => (
                          <DropdownMenuItem key={s} onClick={() => setStage(client.email, s)}>
                            <c.icon className={`h-4 w-4 mr-2 ${c.color.split(' ')[1]}`} />
                            {c.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30 text-[10px] px-1 h-4 shrink-0">
                      {client.source}
                    </Badge>
                  </div>

                  {/* Row 3: Action buttons - Horizontal scroll */}
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
                    {/* ManyChat */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" className="h-7 px-2 shrink-0 bg-[#0084FF]/15 hover:bg-[#0084FF]/25 text-[#0084FF] text-[10px] gap-1">
                          <MessagesSquare className="h-3 w-3" />
                          FB
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="bg-popover border-border">
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'final')}>🚨 Último</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* SMS API */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          size="sm" 
                          disabled={!client.phone}
                          className="h-7 px-2 shrink-0 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-[10px] gap-1 disabled:opacity-30"
                        >
                          <Phone className="h-3 w-3" />
                          SMS
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="bg-popover border-border">
                        <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>🚨 Último</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Native SMS (iPhone) */}
                    {supportsNativeSms() && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button 
                            size="sm" 
                            disabled={!client.phone}
                            className="h-7 px-2 shrink-0 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 text-[10px] gap-1 disabled:opacity-30"
                          >
                            <Smartphone className="h-3 w-3" />
                            Nativo
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="center" className="bg-popover border-border">
                          <DropdownMenuItem onClick={() => handleNativeSms(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleNativeSms(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleNativeSms(client, 'final')}>🚨 Último</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    {/* WhatsApp */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          size="sm" 
                          disabled={!client.phone}
                          className="h-7 px-2 shrink-0 bg-[#25D366] hover:bg-[#1da851] text-white text-[10px] gap-1 disabled:opacity-30"
                        >
                          <MessageCircle className="h-3 w-3" />
                          WA
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-popover border-border">
                        <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>🚨 Último</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block rounded-xl border border-border/50 bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border/50 hover:bg-transparent">
                    <TableHead className="text-muted-foreground">Cliente</TableHead>
                    <TableHead className="text-muted-foreground">Deuda</TableHead>
                    <TableHead className="text-muted-foreground">Etapa</TableHead>
                    <TableHead className="text-muted-foreground">Último Contacto</TableHead>
                    <TableHead className="text-muted-foreground">Fuente</TableHead>
                    <TableHead className="text-muted-foreground">Teléfono</TableHead>
                    <TableHead className="text-right text-muted-foreground">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredClients.map((client, index) => {
                    const stage = getStage(client.email);
                    const config = stageConfig[stage];
                    const StageIcon = config.icon;

                    return (
                      <TableRow key={index} className="border-border/50 hover:bg-muted/20">
                        <TableCell>
                          <div>
                            <p className="font-medium text-foreground">
                              {client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}
                            </p>
                            <p className="text-xs text-muted-foreground">{client.email}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-red-400 font-semibold text-lg">
                            ${client.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Badge variant="outline" className={`cursor-pointer ${config.color}`}>
                                {savingStage === client.email ? (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                ) : (
                                  <StageIcon className="h-3 w-3 mr-1" />
                                )}
                                {config.label}
                              </Badge>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-popover border-border">
                              {(Object.entries(stageConfig) as [RecoveryStage, typeof stageConfig.pending][]).map(([s, c]) => (
                                <DropdownMenuItem key={s} onClick={() => setStage(client.email, s)}>
                                  <c.icon className={`h-4 w-4 mr-2 ${c.color.split(' ')[1]}`} />
                                  {c.label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                        <TableCell>
                          {lastContactDates[client.email] ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                                  <Calendar className="h-3 w-3" />
                                  {formatDistanceToNow(new Date(lastContactDates[client.email]), { addSuffix: true, locale: es })}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                {new Date(lastContactDates[client.email]).toLocaleString('es-MX')}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">Sin contacto</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30">
                            {client.source}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {client.phone ? (
                            <span className="text-sm text-muted-foreground">{client.phone}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">Sin teléfono</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* Portal Link Button */}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleGeneratePortalLink(client)}
                                  disabled={generatingLink === client.email}
                                  className={`gap-1.5 ${
                                    portalLinks[client.email] 
                                      ? 'border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10' 
                                      : 'border-violet-500/30 text-violet-400 hover:bg-violet-500/10'
                                  }`}
                                >
                                  {generatingLink === client.email ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Link2 className="h-4 w-4" />
                                  )}
                                  {portalLinks[client.email] ? 'Copiar' : 'Link'}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {portalLinks[client.email] 
                                  ? 'Copiar link de actualización de tarjeta' 
                                  : 'Generar link para actualizar tarjeta'}
                              </TooltipContent>
                            </Tooltip>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="gap-2 border-[#0084FF]/30 text-[#0084FF] hover:bg-[#0084FF]/10">
                                  <MessagesSquare className="h-4 w-4" />
                                  Messenger
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="bg-popover border-border">
                                <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>😊 Mensaje Amigable</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>⚠️ Mensaje Urgente</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleManyChat(client, 'final')}>🚨 Último Aviso</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>

                            {client.phone && (
                              <>
                                {/* SMS via API */}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="outline" className="gap-1.5 border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
                                      <Phone className="h-4 w-4" />
                                      SMS
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="bg-popover border-border">
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>🚨 Último</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>

                                {/* Native SMS (shows on mobile/tablet) */}
                                {supportsNativeSms() && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button size="sm" variant="outline" className="gap-1.5 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10">
                                        <Smartphone className="h-4 w-4" />
                                        Nativo
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="bg-popover border-border">
                                      <DropdownMenuItem onClick={() => handleNativeSms(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleNativeSms(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                                      <DropdownMenuItem onClick={() => handleNativeSms(client, 'final')}>🚨 Último</DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}

                                {/* WhatsApp */}
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" className="gap-1.5 bg-[#25D366] hover:bg-[#1da851] text-white">
                                      <MessageCircle className="h-4 w-4" />
                                      WA
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="bg-popover border-border">
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>🚨 Último</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
    </TooltipProvider>
  );
}
