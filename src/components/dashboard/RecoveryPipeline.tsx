import { useState } from 'react';
import { MessageCircle, Phone, AlertTriangle, CheckCircle, XCircle, Clock, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { openWhatsApp } from './RecoveryTable';
import type { RecoveryClient } from '@/lib/csvProcessor';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface RecoveryPipelineProps {
  clients: RecoveryClient[];
  onClientClick?: (client: RecoveryClient) => void;
}

type RecoveryStage = 'pending' | 'contacted' | 'paid' | 'lost';

// WhatsApp message templates
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

export function RecoveryPipeline({ clients, onClientClick }: RecoveryPipelineProps) {
  // Track stages locally (in production, this would be persisted)
  const [stages, setStages] = useState<Record<string, RecoveryStage>>({});

  const getStage = (email: string): RecoveryStage => stages[email] || 'pending';

  const setStage = async (email: string, stage: RecoveryStage) => {
    setStages(prev => ({ ...prev, [email]: stage }));
    
    // Log event
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
    
    // Auto-mark as contacted
    if (getStage(client.email) === 'pending') {
      setStage(client.email, 'contacted');
    }
  };

  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-border/50 bg-card p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-yellow-500/10">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Pipeline de Recuperación</h3>
            <p className="text-sm text-muted-foreground">Gestiona pagos fallidos paso a paso</p>
          </div>
        </div>
        <div className="text-center py-8">
          <CheckCircle className="h-12 w-12 mx-auto mb-3 text-emerald-500/50" />
          <p className="text-muted-foreground mb-1">¡Sin pagos fallidos!</p>
          <p className="text-xs text-muted-foreground">Los clientes con pagos fallidos aparecerán aquí</p>
        </div>
      </div>
    );
  }

  const totalDebt = clients.reduce((sum, c) => sum + c.amount, 0);
  const stageCounts = {
    pending: clients.filter(c => getStage(c.email) === 'pending').length,
    contacted: clients.filter(c => getStage(c.email) === 'contacted').length,
    paid: clients.filter(c => getStage(c.email) === 'paid').length,
    lost: clients.filter(c => getStage(c.email) === 'lost').length,
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-border/50">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/10">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground">Pipeline de Recuperación</h3>
              <p className="text-sm text-muted-foreground">{clients.length} clientes por recuperar</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-red-400">${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            <p className="text-xs text-muted-foreground">Deuda total</p>
          </div>
        </div>

        {/* Stage summary */}
        <div className="grid grid-cols-4 gap-2">
          {(Object.entries(stageConfig) as [RecoveryStage, typeof stageConfig.pending][]).map(([stage, config]) => {
            const Icon = config.icon;
            return (
              <div key={stage} className={`rounded-lg border p-2 text-center ${config.color}`}>
                <Icon className="h-4 w-4 mx-auto mb-1" />
                <p className="text-lg font-bold">{stageCounts[stage]}</p>
                <p className="text-[10px]">{config.label}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50 hover:bg-transparent">
              <TableHead className="text-muted-foreground">Cliente</TableHead>
              <TableHead className="text-muted-foreground">Deuda</TableHead>
              <TableHead className="text-muted-foreground">Etapa</TableHead>
              <TableHead className="text-muted-foreground">Fuente</TableHead>
              <TableHead className="text-right text-muted-foreground">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client, index) => {
              const stage = getStage(client.email);
              const config = stageConfig[stage];
              const StageIcon = config.icon;

              return (
                <TableRow 
                  key={index} 
                  className="border-border/50 hover:bg-muted/20 cursor-pointer"
                  onClick={() => onClientClick?.(client)}
                >
                  <TableCell>
                    <div>
                      <p className="font-medium text-foreground">{client.full_name || <span className="text-muted-foreground italic">Sin nombre</span>}</p>
                      <p className="text-xs text-muted-foreground">{client.email}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-red-400 font-semibold">
                      ${client.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Badge variant="outline" className={`cursor-pointer ${config.color}`}>
                          <StageIcon className="h-3 w-3 mr-1" />
                          {config.label}
                        </Badge>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
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
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
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
                      <div className="flex items-center gap-2 text-muted-foreground text-sm">
                        <Phone className="h-4 w-4" />
                        Sin teléfono
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
