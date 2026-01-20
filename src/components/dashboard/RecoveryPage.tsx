import { useState, useMemo } from 'react';
import { MessageCircle, Phone, AlertTriangle, CheckCircle, XCircle, Clock, Send, Filter } from 'lucide-react';
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
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { openWhatsApp } from './RecoveryTable';
import { useMetrics } from '@/hooks/useMetrics';
import { supabase } from '@/integrations/supabase/client';
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-amber-500" />
            Recuperación de Pagos
          </h1>
          <p className="text-muted-foreground mt-1">
            CRM para gestionar pagos fallidos y recuperar ingresos
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-red-400">${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
          <p className="text-sm text-muted-foreground">Deuda total filtrada</p>
        </div>
      </div>

      {/* Stage Summary */}
      <div className="grid grid-cols-4 gap-4">
        {(Object.entries(stageConfig) as [RecoveryStage, typeof stageConfig.pending][]).map(([stage, config]) => {
          const Icon = config.icon;
          return (
            <div key={stage} className={`rounded-xl border p-4 text-center ${config.color}`}>
              <Icon className="h-6 w-6 mx-auto mb-2" />
              <p className="text-2xl font-bold">{stageCounts[stage]}</p>
              <p className="text-sm">{config.label}</p>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}>
            <TabsList className="bg-muted/50">
              <TabsTrigger value="all">Todos</TabsTrigger>
              <TabsTrigger value="stripe">Stripe</TabsTrigger>
              <TabsTrigger value="paypal">PayPal</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="phone-filter"
                checked={showOnlyWithPhone}
                onCheckedChange={setShowOnlyWithPhone}
              />
              <Label htmlFor="phone-filter" className="text-sm cursor-pointer">
                Solo con teléfono
              </Label>
            </div>
            <Badge variant="outline" className="text-muted-foreground">
              {filteredClients.length} clientes
            </Badge>
          </div>
        </div>
      </div>

      {/* Table */}
      {filteredClients.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card p-12 text-center">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-muted-foreground mb-1">¡Sin pagos fallidos!</p>
          <p className="text-xs text-muted-foreground">Los clientes con pagos fallidos aparecerán aquí</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
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
                        <DropdownMenuContent>
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
                      {client.phone ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              className="gap-2 bg-[#25D366] hover:bg-[#1da851] text-white"
                            >
                              <MessageCircle className="h-4 w-4" />
                              WhatsApp
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'friendly')}>
                              😊 Mensaje Amigable
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'urgent')}>
                              ⚠️ Mensaje Urgente
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleWhatsApp(client, 'final')}>
                              🚨 Último Aviso
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <Button size="sm" variant="outline" disabled>
                          <Phone className="h-4 w-4 mr-2" />
                          Sin teléfono
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
