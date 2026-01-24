import { useState, useEffect } from 'react';
import { 
  Send, Users, Play, AlertTriangle, CheckCircle2, 
  RefreshCw, MessageCircle, Smartphone, Mail
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';

interface Segment {
  id: string;
  name: string;
  description: string | null;
  filter_type: string;
}

interface Template {
  id: string;
  name: string;
  channel: string;
  content: string;
}

export function ManualSendPanel() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedSegment, setSelectedSegment] = useState<string>('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [recipientCount, setRecipientCount] = useState<number>(0);
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<{ total: number; excluded: number; toSend: number } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (selectedSegment) {
      countRecipients();
    }
  }, [selectedSegment]);

  const loadData = async () => {
    const [segRes, tempRes] = await Promise.all([
      supabase.from('segments').select('*').eq('is_active', true),
      supabase.from('message_templates').select('*').eq('is_active', true),
    ]);
    
    if (segRes.data) setSegments(segRes.data);
    if (tempRes.data) setTemplates(tempRes.data);
  };

  const countRecipients = async () => {
    const segment = segments.find(s => s.id === selectedSegment);
    if (!segment) return;

    let query = supabase.from('clients').select('id', { count: 'exact', head: true });
    
    switch (segment.filter_type) {
      case 'payment_failed':
        const { data: failedEmails } = await supabase
          .from('transactions')
          .select('customer_email')
          .eq('status', 'failed')
          .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
        
        if (failedEmails && failedEmails.length > 0) {
          const emails = [...new Set(failedEmails.map(t => t.customer_email).filter(Boolean))];
          query = query.in('email', emails);
        } else {
          setRecipientCount(0);
          return;
        }
        break;
      case 'trial_expiring':
        const { data: trialSubs } = await supabase
          .from('subscriptions')
          .select('customer_email')
          .eq('status', 'trialing')
          .lte('trial_end', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        
        if (trialSubs && trialSubs.length > 0) {
          const emails = [...new Set(trialSubs.map(s => s.customer_email).filter(Boolean))];
          query = query.in('email', emails);
        } else {
          setRecipientCount(0);
          return;
        }
        break;
      case 'lead_no_trial':
        query = query.eq('lifecycle_stage', 'LEAD');
        break;
      case 'canceled':
        query = query.eq('lifecycle_stage', 'CHURN');
        break;
      case 'vip':
        query = query.gte('total_spend', 100000);
        break;
    }

    const { count } = await query;
    setRecipientCount(count || 0);
  };

  const handleDryRun = async () => {
    if (!selectedSegment || !selectedTemplate) {
      toast.error('Selecciona segmento y plantilla');
      return;
    }

    setSending(true);
    try {
      // Create a temporary campaign for dry run
      const template = templates.find(t => t.id === selectedTemplate);
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .insert({
          name: `Manual Send - ${new Date().toLocaleString()}`,
          segment_id: selectedSegment,
          template_id: selectedTemplate,
          channel: template?.channel || 'sms',
          dry_run: true,
          status: 'draft',
        })
        .select()
        .single();

      if (error) throw error;

      // Call send-campaign with dry_run
      const result = await invokeWithAdminKey<{ stats?: { total?: number; excluded?: number } }>('send-campaign', { campaign_id: campaign.id, dry_run: true });

      setDryRunResult({
        total: result.stats?.total ?? 0,
        excluded: result.stats?.excluded ?? 0,
        toSend: (result.stats?.total ?? 0) - (result.stats?.excluded ?? 0),
      });

      // Delete the temporary campaign
      await supabase.from('campaigns').delete().eq('id', campaign.id);
      
      setConfirmOpen(true);
    } catch (error) {
      console.error('Dry run error:', error);
      toast.error('Error en simulación');
    }
    setSending(false);
  };

  const handleSend = async () => {
    if (!selectedSegment || !selectedTemplate) return;

    setSending(true);
    setConfirmOpen(false);

    try {
      const template = templates.find(t => t.id === selectedTemplate);
      const segment = segments.find(s => s.id === selectedSegment);

      // Create campaign
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .insert({
          name: `Manual: ${segment?.name} - ${template?.name}`,
          segment_id: selectedSegment,
          template_id: selectedTemplate,
          channel: template?.channel || 'sms',
          status: 'draft',
        })
        .select()
        .single();

      if (error) throw error;

      // Send campaign
      const result = await invokeWithAdminKey<{ stats?: { sent?: number } }>('send-campaign', { campaign_id: campaign.id });

      toast.success(`Enviado: ${result.stats?.sent ?? 0} mensajes`);
      setSelectedSegment('');
      setSelectedTemplate('');
      setRecipientCount(0);
    } catch (error) {
      console.error('Send error:', error);
      toast.error('Error enviando campaña');
    }
    setSending(false);
  };

  const selectedTemplateFull = templates.find(t => t.id === selectedTemplate);
  const channelIcon = {
    whatsapp: MessageCircle,
    sms: Smartphone,
    email: Mail,
  }[selectedTemplateFull?.channel || 'sms'] || Smartphone;
  const ChannelIcon = channelIcon;

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2">
          <Send className="h-5 w-5 text-primary" />
          Envío Manual
        </CardTitle>
        <CardDescription>
          Selecciona un segmento y plantilla para enviar mensajes
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Segmento</label>
            <Select value={selectedSegment} onValueChange={setSelectedSegment}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar segmento" />
              </SelectTrigger>
              <SelectContent>
                {segments.map(seg => (
                  <SelectItem key={seg.id} value={seg.id}>
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      {seg.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Plantilla</label>
            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="Seleccionar plantilla" />
              </SelectTrigger>
              <SelectContent>
                {templates.map(temp => (
                  <SelectItem key={temp.id} value={temp.id}>
                    <div className="flex items-center gap-2">
                      {temp.channel === 'whatsapp' && <MessageCircle className="h-4 w-4 text-[#25D366]" />}
                      {temp.channel === 'sms' && <Smartphone className="h-4 w-4 text-blue-400" />}
                      {temp.channel === 'email' && <Mail className="h-4 w-4 text-purple-400" />}
                      {temp.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedSegment && (
          <div className="flex items-center gap-4 p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Destinatarios:</span>
              <Badge variant="secondary" className="text-lg">
                {recipientCount.toLocaleString()}
              </Badge>
            </div>
            {selectedTemplateFull && (
              <div className="flex items-center gap-2">
                <ChannelIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Canal:</span>
                <Badge variant="outline">{selectedTemplateFull.channel}</Badge>
              </div>
            )}
          </div>
        )}

        {selectedTemplateFull && (
          <div className="p-3 bg-muted/20 rounded-lg">
            <p className="text-xs text-muted-foreground mb-1">Vista previa:</p>
            <p className="text-sm text-white line-clamp-2">{selectedTemplateFull.content}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button 
            variant="outline" 
            onClick={handleDryRun}
            disabled={!selectedSegment || !selectedTemplate || sending}
            className="flex-1"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${sending ? 'animate-spin' : ''}`} />
            Simular (Dry Run)
          </Button>
          <Button 
            onClick={() => setConfirmOpen(true)}
            disabled={!selectedSegment || !selectedTemplate || sending}
            className="flex-1"
          >
            <Play className="h-4 w-4 mr-2" />
            Enviar
          </Button>
        </div>
      </CardContent>

      {/* Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              Confirmar Envío
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {dryRunResult ? (
              <div className="space-y-2">
                <div className="flex justify-between p-2 bg-muted/30 rounded">
                  <span>Total en segmento:</span>
                  <Badge variant="secondary">{dryRunResult.total}</Badge>
                </div>
                <div className="flex justify-between p-2 bg-muted/30 rounded">
                  <span>Excluidos (opt-out, sin contacto):</span>
                  <Badge variant="outline">{dryRunResult.excluded}</Badge>
                </div>
                <div className="flex justify-between p-2 bg-green-500/10 rounded border border-green-500/20">
                  <span className="text-green-400 font-medium">Se enviarán:</span>
                  <Badge className="bg-green-500">{dryRunResult.toSend}</Badge>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">
                Se enviará a <strong>{recipientCount}</strong> destinatarios del segmento{' '}
                <strong>{segments.find(s => s.id === selectedSegment)?.name}</strong>.
              </p>
            )}
            
            <p className="text-sm text-amber-400 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Esta acción no se puede deshacer.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSend} disabled={sending}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Confirmar Envío
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
