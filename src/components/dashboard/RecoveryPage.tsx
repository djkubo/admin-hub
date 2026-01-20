import { useState, useMemo } from 'react';
import { MessageCircle, Phone, AlertTriangle, CheckCircle, XCircle, Clock, Send, Filter, Smartphone, Facebook } from 'lucide-react';
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
import { openWhatsApp } from './RecoveryTable';
import { useMetrics } from '@/hooks/useMetrics';
import { supabase } from '@/integrations/supabase/client';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';
import type { RecoveryClient } from '@/lib/csvProcessor';

type RecoveryStage = 'pending' | 'contacted' | 'paid' | 'lost';

const messageTemplates = {
  friendly: (name: string, amount: number) => 
    `Hola ${name || 'usuario'} 👋 Notamos que hubo un problemita con tu pago de $${amount.toFixed(2)}. ¿Te podemos ayudar a resolverlo? Estamos para servirte 🙌`,
  urgent: (name: string, amount: number) => 
    `Hola ${name || 'usuario'}, tu pago de $${amount.toFixed(2)} no pudo procesarse y tu suscripción está en riesgo. Por favor actualiza tu método de pago lo antes posible para evitar la suspensión del servicio.`,
  final: (name: string, amount: number) => 
    `Hola ${name || 'usuario'}, este es un último aviso sobre tu pago pendiente de $${amount.toFixed(2)}. Si no recibimos el pago en las próximas 24 horas, tu cuenta será suspendida. ¿Hay algo en lo que podamos ayudarte?`,
};

const stageConfig: Record<RecoveryStage, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: 'Pendiente', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: Clock },
  contacted: { label: 'Contactado', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30', icon: Send },
  paid: { label: 'Pagó', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: CheckCircle },
  lost: { label: 'Perdido', color: 'bg-red-500/10 text-red-400 border-red-500/30', icon: XCircle },
};

export function RecoveryPage() {
  const { metrics } = useMetrics();
  const [stages, setStages] = useState<Record<string, RecoveryStage>>({});
  const [showOnlyWithPhone, setShowOnlyWithPhone] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'stripe' | 'paypal'>('all');

  const getStage = (email: string): RecoveryStage => stages[email] || 'pending';

  const setStage = async (email: string, stage: RecoveryStage) => {
    setStages(prev => ({ ...prev, [email]: stage }));
    
    try {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('email', email)
        .single();
      
      if (client) {
        await supabase.from('client_events').insert({
          client_id: client.id,
          event_type: 'custom',
          metadata: { action: 'recovery_stage_change', stage, timestamp: new Date().toISOString() },
        });
      }
    } catch (e) {
      console.error('Error logging event:', e);
    }
    
    toast.success(`Estado actualizado a: ${stageConfig[stage].label}`);
  };

  const handleWhatsApp = async (client: RecoveryClient, template: 'friendly' | 'urgent' | 'final') => {
    if (!client.phone) return;
    
    const message = messageTemplates[template](client.full_name || '', client.amount);
    openWhatsApp(client.phone, client.full_name || '', message);
    
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
    <div className="space-y-4 md:space-y-6">
      {/* Header - Responsive */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white flex items-center gap-2 md:gap-3">
            <AlertTriangle className="h-6 w-6 md:h-8 md:w-8 text-amber-500" />
            Recuperación
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            CRM para gestionar pagos fallidos
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-2xl md:text-3xl font-bold text-red-400">${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
          <p className="text-xs md:text-sm text-muted-foreground">Deuda total</p>
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
          <div className="md:hidden space-y-3">
            {filteredClients.map((client, index) => {
              const stage = getStage(client.email);
              const config = stageConfig[stage];
              const StageIcon = config.icon;

              return (
                <div key={index} className="rounded-xl border border-border/50 bg-card p-4 touch-feedback">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">
                        {client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{client.email}</p>
                    </div>
                    <span className="text-lg font-bold text-red-400 ml-2">
                      ${client.amount.toFixed(2)}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 mb-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Badge variant="outline" className={`cursor-pointer text-xs ${config.color}`}>
                          <StageIcon className="h-3 w-3 mr-1" />
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
                    <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/30 text-xs">
                      {client.source}
                    </Badge>
                    {client.phone && (
                      <span className="text-xs text-muted-foreground truncate">{client.phone}</span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline" className="gap-1.5 text-xs border-[#0084FF]/30 text-[#0084FF] h-8 touch-feedback">
                          <Facebook className="h-3.5 w-3.5" />
                          FB
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="bg-popover border-border">
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleManyChat(client, 'final')}>🚨 Último</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {client.phone && (
                      <>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline" className="gap-1.5 text-xs border-blue-500/30 text-blue-400 h-8 touch-feedback">
                              <Smartphone className="h-3.5 w-3.5" />
                              SMS
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="bg-popover border-border">
                            <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>😊 Amigable</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>⚠️ Urgente</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>🚨 Último</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" className="gap-1.5 text-xs bg-[#25D366] hover:bg-[#1da851] text-white h-8 touch-feedback">
                              <MessageCircle className="h-3.5 w-3.5" />
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
                                <StageIcon className="h-3 w-3 mr-1" />
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
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="gap-2 border-[#0084FF]/30 text-[#0084FF] hover:bg-[#0084FF]/10">
                                  <Facebook className="h-4 w-4" />
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
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="outline" className="gap-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
                                      <Smartphone className="h-4 w-4" />
                                      SMS
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="bg-popover border-border">
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'friendly')}>😊 Mensaje Amigable</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'urgent')}>⚠️ Mensaje Urgente</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSMS(client, 'final')}>🚨 Último Aviso</DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>

                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="sm" className="gap-2 bg-[#25D366] hover:bg-[#1da851] text-white">
                                      <MessageCircle className="h-4 w-4" />
                                      WhatsApp
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="bg-popover border-border">
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>😊 Mensaje Amigable</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>⚠️ Mensaje Urgente</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>🚨 Último Aviso</DropdownMenuItem>
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
  );
}
