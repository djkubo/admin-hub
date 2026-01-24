import { useState, useEffect } from 'react';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { 
  FileText, Users, Send, Plus, Edit2, Trash2, Eye, Play, Pause,
  MessageCircle, Smartphone, Mail, Facebook, Copy, Check, X,
  RefreshCw, Settings, Filter, Clock, Shield, AlertTriangle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Template {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  content: string;
  variables: string[];
  version: number;
  is_active: boolean;
}

interface Segment {
  id: string;
  name: string;
  description: string | null;
  filter_type: string;
  exclude_refunds: boolean;
  exclude_no_phone: boolean;
  is_active: boolean;
  client_count?: number;
}

interface Campaign {
  id: string;
  name: string;
  segment_id: string | null;
  template_id: string | null;
  status: string;
  channel: string;
  respect_opt_out: boolean;
  respect_quiet_hours: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  rate_limit_per_minute: number;
  dedupe_hours: number;
  dry_run: boolean;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  replied_count: number;
  converted_count: number;
  failed_count: number;
  created_at: string;
  sent_at: string | null;
  segment?: Segment;
  template?: Template;
}

const channelIcons: Record<string, typeof MessageCircle> = {
  whatsapp: MessageCircle,
  sms: Smartphone,
  email: Mail,
  messenger: Facebook,
};

const channelColors: Record<string, string> = {
  whatsapp: 'bg-[#25D366]/10 text-[#25D366] border-[#25D366]/30',
  sms: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  email: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  messenger: 'bg-[#0084FF]/10 text-[#0084FF] border-[#0084FF]/30',
};

export function CampaignControlCenter() {
  const [activeTab, setActiveTab] = useState('campaigns');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog states
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [campaignDialogOpen, setCampaignDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [previewCampaign, setPreviewCampaign] = useState<Campaign | null>(null);
  const [previewRecipients, setPreviewRecipients] = useState<Array<{ email: string; full_name: string; phone: string | null }>>([]);

  // Form states
  const [templateForm, setTemplateForm] = useState({
    name: '',
    channel: 'whatsapp',
    subject: '',
    content: '',
  });

  const [campaignForm, setCampaignForm] = useState({
    name: '',
    segment_id: '',
    template_id: '',
    channel: 'whatsapp',
    respect_opt_out: true,
    respect_quiet_hours: false,
    dedupe_hours: 24,
    rate_limit_per_minute: 30,
    dry_run: false,
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [templatesRes, segmentsRes, campaignsRes] = await Promise.all([
        supabase.from('message_templates').select('*').order('created_at', { ascending: false }),
        supabase.from('segments').select('*').order('created_at', { ascending: false }),
        supabase.from('campaigns').select('*, segment:segments(*), template:message_templates(*)').order('created_at', { ascending: false }),
      ]);

      if (templatesRes.data) setTemplates(templatesRes.data);
      if (segmentsRes.data) {
        // Get client counts for each segment
        const segmentsWithCounts = await Promise.all(
          segmentsRes.data.map(async (seg) => {
            const count = await getSegmentClientCount(seg);
            return { ...seg, client_count: count };
          })
        );
        setSegments(segmentsWithCounts);
      }
      if (campaignsRes.data) setCampaigns(campaignsRes.data as Campaign[]);
    } catch (error) {
      console.error('Error loading data:', error);
    }
    setLoading(false);
  };

  const getSegmentClientCount = async (segment: Segment): Promise<number> => {
    let query = supabase.from('clients').select('id', { count: 'exact', head: true });

    switch (segment.filter_type) {
      case 'payment_failed':
        // Clients with failed transactions in last 30 days
        const { data: failedEmails } = await supabase
          .from('transactions')
          .select('customer_email')
          .eq('status', 'failed')
          .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
        
        if (failedEmails && failedEmails.length > 0) {
          const emails = [...new Set(failedEmails.map(t => t.customer_email).filter(Boolean))];
          query = query.in('email', emails);
        } else {
          return 0;
        }
        break;
      case 'trial_expiring':
        // Get trials expiring in 3 days
        const { data: trialingSubs } = await supabase
          .from('subscriptions')
          .select('customer_email')
          .eq('status', 'trialing')
          .lte('trial_end', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        
        if (trialingSubs && trialingSubs.length > 0) {
          const emails = [...new Set(trialingSubs.map(s => s.customer_email).filter(Boolean))];
          query = query.in('email', emails);
        } else {
          return 0;
        }
        break;
      case 'lead_no_trial':
        query = query.eq('lifecycle_stage', 'LEAD');
        break;
      case 'canceled':
        query = query.eq('lifecycle_stage', 'CHURN');
        break;
      case 'vip':
        query = query.gte('total_spend', 100000); // $1000 in cents
        break;
      case 'custom':
        if (segment.exclude_no_phone) {
          query = query.not('phone', 'is', null);
        }
        break;
    }

    const { count } = await query;
    return count || 0;
  };

  useEffect(() => {
    loadData();
  }, []);

  // Template handlers
  const handleSaveTemplate = async () => {
    try {
      const variables = templateForm.content.match(/\{\{(\w+)\}\}/g)?.map(v => v.replace(/[{}]/g, '')) || [];
      
      if (editingTemplate) {
        // Save version history
        await supabase.from('template_versions').insert({
          template_id: editingTemplate.id,
          version: editingTemplate.version,
          content: editingTemplate.content,
          subject: editingTemplate.subject,
        });

        // Update template
        await supabase.from('message_templates').update({
          ...templateForm,
          variables,
          version: editingTemplate.version + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', editingTemplate.id);
      } else {
        await supabase.from('message_templates').insert({
          ...templateForm,
          variables,
        });
      }

      toast.success(editingTemplate ? 'Plantilla actualizada' : 'Plantilla creada');
      setTemplateDialogOpen(false);
      setEditingTemplate(null);
      setTemplateForm({ name: '', channel: 'whatsapp', subject: '', content: '' });
      loadData();
    } catch (error) {
      toast.error('Error guardando plantilla');
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    if (error) {
      console.error('Error deleting template:', error);
      toast.error('Error eliminando plantilla: ' + error.message);
      return;
    }
    toast.success('Plantilla eliminada');
    loadData();
  };

  // Campaign handlers
  const handleSaveCampaign = async () => {
    try {
      if (editingCampaign) {
        await supabase.from('campaigns').update({
          ...campaignForm,
          updated_at: new Date().toISOString(),
        }).eq('id', editingCampaign.id);
      } else {
        const { data: campaign } = await supabase.from('campaigns').insert({
          ...campaignForm,
        }).select().single();

        // Populate recipients from segment
        if (campaign && campaignForm.segment_id) {
          await populateCampaignRecipients(campaign.id, campaignForm.segment_id);
        }
      }

      toast.success(editingCampaign ? 'Campaña actualizada' : 'Campaña creada');
      setCampaignDialogOpen(false);
      setEditingCampaign(null);
      setCampaignForm({
        name: '',
        segment_id: '',
        template_id: '',
        channel: 'whatsapp',
        respect_opt_out: true,
        respect_quiet_hours: false,
        dedupe_hours: 24,
        rate_limit_per_minute: 30,
        dry_run: false,
      });
      loadData();
    } catch (error) {
      toast.error('Error guardando campaña');
    }
  };

  const populateCampaignRecipients = async (campaignId: string, segmentId: string) => {
    const segment = segments.find(s => s.id === segmentId);
    if (!segment) return;

    let clientQuery = supabase.from('clients').select('id, email');

    switch (segment.filter_type) {
      case 'payment_failed':
        const { data: failedEmails } = await supabase
          .from('transactions')
          .select('customer_email')
          .eq('status', 'failed')
          .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
        
        if (failedEmails && failedEmails.length > 0) {
          const emails = [...new Set(failedEmails.map(t => t.customer_email).filter(Boolean))];
          clientQuery = clientQuery.in('email', emails);
        }
        break;
      case 'trial_expiring':
        const { data: trialingSubs } = await supabase
          .from('subscriptions')
          .select('customer_email')
          .eq('status', 'trialing')
          .lte('trial_end', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
        
        if (trialingSubs && trialingSubs.length > 0) {
          const emails = [...new Set(trialingSubs.map(s => s.customer_email).filter(Boolean))];
          clientQuery = clientQuery.in('email', emails);
        }
        break;
      case 'lead_no_trial':
        clientQuery = clientQuery.eq('lifecycle_stage', 'LEAD');
        break;
      case 'canceled':
        clientQuery = clientQuery.eq('lifecycle_stage', 'CHURN');
        break;
      case 'vip':
        clientQuery = clientQuery.gte('total_spend', 100000);
        break;
    }

    if (segment.exclude_no_phone) {
      clientQuery = clientQuery.not('phone', 'is', null);
    }

    const { data: clients } = await clientQuery;

    if (clients && clients.length > 0) {
      const recipients = clients.map(c => ({
        campaign_id: campaignId,
        client_id: c.id,
        status: 'pending' as const,
      }));

      const { error: insertError } = await supabase.from('campaign_recipients').insert(recipients);
      if (insertError) {
        console.error('Error inserting campaign recipients:', insertError);
      }
      
      const { error: updateError } = await supabase.from('campaigns').update({ total_recipients: clients.length }).eq('id', campaignId);
      if (updateError) {
        console.error('Error updating campaign recipient count:', updateError);
      }
    }
  };

  const handlePreviewCampaign = async (campaign: Campaign) => {
    setPreviewCampaign(campaign);
    
    const { data: recipients } = await supabase
      .from('campaign_recipients')
      .select('client:clients(email, full_name, phone)')
      .eq('campaign_id', campaign.id)
      .eq('status', 'pending')
      .limit(20);

    setPreviewRecipients(
      (recipients || [])
        .map(r => r.client as unknown as { email: string; full_name: string; phone: string | null })
        .filter(Boolean)
    );
    setPreviewDialogOpen(true);
  };

  const handleDryRun = async (campaign: Campaign) => {
    toast.loading('Ejecutando dry run...', { id: 'dry-run' });
    
    try {
      const data = await invokeWithAdminKey<{ stats?: { total?: number; excluded?: number } }>('send-campaign', { campaign_id: campaign.id, dry_run: true });
      toast.success(`Dry run completado: ${data.stats?.total ?? 0} destinatarios, ${data.stats?.excluded ?? 0} excluidos`, { id: 'dry-run' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error('Error: ' + message, { id: 'dry-run' });
    }
  };

  const handleSendCampaign = async (campaign: Campaign) => {
    if (campaign.status !== 'draft') {
      toast.error('Solo se pueden enviar campañas en estado borrador');
      return;
    }

    toast.loading('Enviando campaña...', { id: 'send-campaign' });
    
    try {
      const data = await invokeWithAdminKey<{ stats?: { sent?: number; failed?: number } }>('send-campaign', { campaign_id: campaign.id });
      toast.success(`Campaña enviada: ${data.stats?.sent ?? 0} enviados, ${data.stats?.failed ?? 0} fallidos`, { id: 'send-campaign' });
      loadData();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast.error('Error: ' + message, { id: 'send-campaign' });
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    const { error } = await supabase.from('campaigns').delete().eq('id', id);
    if (error) {
      console.error('Error deleting campaign:', error);
      toast.error('Error eliminando campaña: ' + error.message);
      return;
    }
    toast.success('Campaña eliminada');
    loadData();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Send className="h-8 w-8 text-primary" />
            Campaign Control Center
          </h1>
          <p className="text-muted-foreground mt-1">
            Gestión manual de campañas multicanal con guardrails de seguridad
          </p>
        </div>
        <Button onClick={loadData} variant="outline" className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </Button>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-muted/50">
          <TabsTrigger value="campaigns" className="gap-2">
            <Send className="h-4 w-4" />
            Campañas
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-2">
            <FileText className="h-4 w-4" />
            Plantillas
          </TabsTrigger>
          <TabsTrigger value="segments" className="gap-2">
            <Users className="h-4 w-4" />
            Segmentos
          </TabsTrigger>
        </TabsList>

        {/* Campaigns Tab */}
        <TabsContent value="campaigns" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Dialog open={campaignDialogOpen} onOpenChange={setCampaignDialogOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => {
                  setEditingCampaign(null);
                  setCampaignForm({
                    name: '',
                    segment_id: '',
                    template_id: '',
                    channel: 'whatsapp',
                    respect_opt_out: true,
                    respect_quiet_hours: false,
                    dedupe_hours: 24,
                    rate_limit_per_minute: 30,
                    dry_run: false,
                  });
                }}>
                  <Plus className="h-4 w-4" />
                  Nueva Campaña
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{editingCampaign ? 'Editar' : 'Nueva'} Campaña</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label>Nombre</Label>
                    <Input
                      value={campaignForm.name}
                      onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })}
                      placeholder="Ej: Recuperación Diciembre"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Segmento</Label>
                      <Select value={campaignForm.segment_id} onValueChange={(v) => setCampaignForm({ ...campaignForm, segment_id: v })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Seleccionar segmento" />
                        </SelectTrigger>
                        <SelectContent>
                          {segments.map(s => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name} ({s.client_count || 0})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Canal</Label>
                      <Select value={campaignForm.channel} onValueChange={(v) => setCampaignForm({ ...campaignForm, channel: v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="whatsapp">WhatsApp</SelectItem>
                          <SelectItem value="sms">SMS</SelectItem>
                          <SelectItem value="messenger">Messenger</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Plantilla</Label>
                    <Select value={campaignForm.template_id} onValueChange={(v) => setCampaignForm({ ...campaignForm, template_id: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Seleccionar plantilla" />
                      </SelectTrigger>
                      <SelectContent>
                        {templates.filter(t => t.channel === campaignForm.channel).map(t => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name} (v{t.version})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Guardrails */}
                  <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
                    <h4 className="font-medium flex items-center gap-2">
                      <Shield className="h-4 w-4" />
                      Guardrails de Seguridad
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-center justify-between">
                        <Label>Respetar Opt-Out</Label>
                        <Switch
                          checked={campaignForm.respect_opt_out}
                          onCheckedChange={(v) => setCampaignForm({ ...campaignForm, respect_opt_out: v })}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label>Quiet Hours</Label>
                        <Switch
                          checked={campaignForm.respect_quiet_hours}
                          onCheckedChange={(v) => setCampaignForm({ ...campaignForm, respect_quiet_hours: v })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>Dedupe (horas)</Label>
                        <Input
                          type="number"
                          value={campaignForm.dedupe_hours}
                          onChange={(e) => setCampaignForm({ ...campaignForm, dedupe_hours: parseInt(e.target.value) || 24 })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>Rate Limit (msg/min)</Label>
                        <Input
                          type="number"
                          value={campaignForm.rate_limit_per_minute}
                          onChange={(e) => setCampaignForm({ ...campaignForm, rate_limit_per_minute: parseInt(e.target.value) || 30 })}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCampaignDialogOpen(false)}>Cancelar</Button>
                  <Button onClick={handleSaveCampaign}>
                    {editingCampaign ? 'Guardar' : 'Crear Campaña'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Campaigns Table */}
          <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-border/50">
                  <TableHead>Campaña</TableHead>
                  <TableHead>Segmento</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Métricas</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map(campaign => {
                  const ChannelIcon = channelIcons[campaign.channel] || MessageCircle;
                  return (
                    <TableRow key={campaign.id} className="border-border/50">
                      <TableCell>
                        <div>
                          <p className="font-medium">{campaign.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(campaign.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{campaign.segment?.name || 'Sin segmento'}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={channelColors[campaign.channel]}>
                          <ChannelIcon className="h-3 w-3 mr-1" />
                          {campaign.channel}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant="outline"
                          className={
                            campaign.status === 'draft' ? 'text-muted-foreground' :
                            campaign.status === 'sent' ? 'text-emerald-400 border-emerald-500/30' :
                            campaign.status === 'sending' ? 'text-blue-400 border-blue-500/30' :
                            'text-amber-400'
                          }
                        >
                          {campaign.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">Enviados:</span>
                            <span className="font-medium">{campaign.sent_count}/{campaign.total_recipients}</span>
                          </div>
                          {campaign.converted_count > 0 && (
                            <div className="flex items-center gap-2">
                              <span className="text-emerald-400">Convertidos:</span>
                              <span className="font-medium text-emerald-400">{campaign.converted_count}</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handlePreviewCampaign(campaign)}>
                            <Eye className="h-4 w-4" />
                          </Button>
                          {campaign.status === 'draft' && (
                            <>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-amber-400" onClick={() => handleDryRun(campaign)}>
                                <AlertTriangle className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-400" onClick={() => handleSendCampaign(campaign)}>
                                <Play className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400" onClick={() => handleDeleteCampaign(campaign.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {campaigns.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No hay campañas creadas
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2" onClick={() => {
                  setEditingTemplate(null);
                  setTemplateForm({ name: '', channel: 'whatsapp', subject: '', content: '' });
                }}>
                  <Plus className="h-4 w-4" />
                  Nueva Plantilla
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{editingTemplate ? 'Editar' : 'Nueva'} Plantilla</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Nombre</Label>
                      <Input
                        value={templateForm.name}
                        onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                        placeholder="Ej: Pago Fallido - Amigable"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Canal</Label>
                      <Select value={templateForm.channel} onValueChange={(v) => setTemplateForm({ ...templateForm, channel: v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="whatsapp">WhatsApp</SelectItem>
                          <SelectItem value="sms">SMS</SelectItem>
                          <SelectItem value="messenger">Messenger</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {templateForm.channel === 'email' && (
                    <div className="grid gap-2">
                      <Label>Asunto</Label>
                      <Input
                        value={templateForm.subject}
                        onChange={(e) => setTemplateForm({ ...templateForm, subject: e.target.value })}
                        placeholder="Ej: Actualiza tu método de pago"
                      />
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label>Contenido</Label>
                    <Textarea
                      rows={6}
                      value={templateForm.content}
                      onChange={(e) => setTemplateForm({ ...templateForm, content: e.target.value })}
                      placeholder="Usa {{name}}, {{amount}}, {{days_left}} como variables"
                    />
                    <p className="text-xs text-muted-foreground">
                      Variables disponibles: {'{{name}}'}, {'{{amount}}'}, {'{{days_left}}'}
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setTemplateDialogOpen(false)}>Cancelar</Button>
                  <Button onClick={handleSaveTemplate}>
                    {editingTemplate ? 'Guardar' : 'Crear Plantilla'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Templates Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map(template => {
              const ChannelIcon = channelIcons[template.channel] || MessageCircle;
              return (
                <Card key={template.id} className="border-border/50">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={channelColors[template.channel]}>
                        <ChannelIcon className="h-3 w-3 mr-1" />
                        {template.channel}
                      </Badge>
                      <Badge variant="secondary">v{template.version}</Badge>
                    </div>
                    <CardTitle className="text-lg">{template.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-3 mb-4">
                      {template.content}
                    </p>
                    <div className="flex items-center justify-between">
                      <div className="flex gap-1">
                        {template.variables?.map(v => (
                          <Badge key={v} variant="outline" className="text-xs">
                            {'{{'}{v}{'}}'}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => {
                            setEditingTemplate(template);
                            setTemplateForm({
                              name: template.name,
                              channel: template.channel,
                              subject: template.subject || '',
                              content: template.content,
                            });
                            setTemplateDialogOpen(true);
                          }}
                        >
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-red-400"
                          onClick={() => handleDeleteTemplate(template.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* Segments Tab */}
        <TabsContent value="segments" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {segments.map(segment => (
              <Card key={segment.id} className="border-border/50">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{segment.name}</CardTitle>
                    <Badge variant="secondary" className="text-lg">
                      {segment.client_count || 0}
                    </Badge>
                  </div>
                  <CardDescription>{segment.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2 flex-wrap">
                    <Badge variant="outline">{segment.filter_type}</Badge>
                    {segment.exclude_refunds && (
                      <Badge variant="outline" className="text-amber-400">Sin refunds</Badge>
                    )}
                    {segment.exclude_no_phone && (
                      <Badge variant="outline" className="text-blue-400">Con teléfono</Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Preview Dialog */}
      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview: {previewCampaign?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground">Segmento</Label>
                <p className="font-medium">{previewCampaign?.segment?.name}</p>
              </div>
              <div>
                <Label className="text-muted-foreground">Plantilla</Label>
                <p className="font-medium">{previewCampaign?.template?.name}</p>
              </div>
            </div>
            <div className="border rounded-lg p-4 bg-muted/30">
              <Label className="text-muted-foreground">Mensaje</Label>
              <p className="mt-2 whitespace-pre-wrap">{previewCampaign?.template?.content}</p>
            </div>
            <div>
              <Label className="text-muted-foreground mb-2 block">
                Destinatarios ({previewCampaign?.total_recipients || 0} total, mostrando primeros 20)
              </Label>
              <div className="max-h-48 overflow-y-auto border rounded-lg">
                <Table>
                  <TableBody>
                    {previewRecipients.map((r, i) => (
                      <TableRow key={i} className="border-border/50">
                        <TableCell>{r.full_name || 'Sin nombre'}</TableCell>
                        <TableCell className="text-muted-foreground">{r.email}</TableCell>
                        <TableCell className="text-muted-foreground">{r.phone || 'Sin teléfono'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
