import { useState, useEffect } from 'react';
import { 
  FileText, Plus, Edit2, Trash2, Save, X, Eye,
  MessageCircle, Smartphone, Mail, Facebook
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  created_at: string;
}

const channelConfig: Record<string, { icon: typeof MessageCircle; label: string; color: string }> = {
  whatsapp: { icon: MessageCircle, label: 'WhatsApp', color: 'bg-[#25D366]/10 text-[#25D366] border-[#25D366]/30' },
  sms: { icon: Smartphone, label: 'SMS', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  email: { icon: Mail, label: 'Email', color: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  messenger: { icon: Facebook, label: 'Messenger', color: 'bg-[#0084FF]/10 text-[#0084FF] border-[#0084FF]/30' },
};

export function TemplateManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);
  
  const [form, setForm] = useState({
    name: '',
    channel: 'whatsapp',
    subject: '',
    content: '',
  });

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('message_templates')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) {
      toast.error('Error cargando plantillas');
    } else {
      setTemplates(data || []);
    }
    setLoading(false);
  };

  const handleOpenNew = () => {
    setEditingTemplate(null);
    setForm({ name: '', channel: 'whatsapp', subject: '', content: '' });
    setDialogOpen(true);
  };

  const handleEdit = (template: Template) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      channel: template.channel,
      subject: template.subject || '',
      content: template.content,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.content) {
      toast.error('Nombre y contenido son requeridos');
      return;
    }

    const variables = form.content.match(/\{\{(\w+)\}\}/g)?.map(v => v.replace(/[{}]/g, '')) || [];
    
    try {
      if (editingTemplate) {
        // Save version history
        await supabase.from('template_versions').insert({
          template_id: editingTemplate.id,
          version: editingTemplate.version,
          content: editingTemplate.content,
          subject: editingTemplate.subject,
        });

        await supabase.from('message_templates').update({
          name: form.name,
          channel: form.channel,
          subject: form.subject || null,
          content: form.content,
          variables,
          version: editingTemplate.version + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', editingTemplate.id);
        
        toast.success('Plantilla actualizada');
      } else {
        await supabase.from('message_templates').insert({
          name: form.name,
          channel: form.channel,
          subject: form.subject || null,
          content: form.content,
          variables,
        });
        toast.success('Plantilla creada');
      }
      
      setDialogOpen(false);
      loadTemplates();
    } catch (error) {
      toast.error('Error guardando plantilla');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar esta plantilla?')) return;
    
    await supabase.from('message_templates').delete().eq('id', id);
    toast.success('Plantilla eliminada');
    loadTemplates();
  };

  const handlePreview = (template: Template) => {
    setPreviewTemplate(template);
    setPreviewOpen(true);
  };

  const extractVariables = (content: string) => {
    const matches = content.match(/\{\{(\w+)\}\}/g);
    return matches ? [...new Set(matches.map(v => v.replace(/[{}]/g, '')))] : [];
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" />
            Plantillas de Mensajes
          </h2>
          <p className="text-muted-foreground">
            Gestiona plantillas para SMS, WhatsApp y Email
          </p>
        </div>
        <Button onClick={handleOpenNew} className="gap-2">
          <Plus className="h-4 w-4" />
          Nueva Plantilla
        </Button>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((template) => {
          const config = channelConfig[template.channel] || channelConfig.sms;
          const Icon = config.icon;
          const variables = extractVariables(template.content);
          
          return (
            <Card key={template.id} className="bg-card border-border hover:border-primary/30 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-white text-lg">{template.name}</CardTitle>
                    <Badge variant="outline" className={config.color}>
                      <Icon className="h-3 w-3 mr-1" />
                      {config.label}
                    </Badge>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    v{template.version}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {template.subject && (
                  <div className="text-sm text-muted-foreground">
                    <span className="text-xs uppercase tracking-wide">Asunto:</span>
                    <p className="truncate">{template.subject}</p>
                  </div>
                )}
                
                <div className="text-sm text-muted-foreground line-clamp-3 bg-muted/30 p-2 rounded">
                  {template.content}
                </div>
                
                {variables.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {variables.map(v => (
                      <Badge key={v} variant="outline" className="text-xs">
                        {`{{${v}}}`}
                      </Badge>
                    ))}
                  </div>
                )}
                
                <div className="flex items-center gap-2 pt-2">
                  <Button size="sm" variant="ghost" onClick={() => handlePreview(template)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleEdit(template)}>
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => handleDelete(template.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {templates.length === 0 && !loading && (
          <Card className="col-span-full bg-muted/20 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No hay plantillas creadas</p>
              <Button variant="outline" className="mt-4" onClick={handleOpenNew}>
                Crear primera plantilla
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? 'Editar Plantilla' : 'Nueva Plantilla'}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nombre</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ej: Recordatorio de pago"
                />
              </div>
              <div className="space-y-2">
                <Label>Canal</Label>
                <Select value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="messenger">Messenger</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.channel === 'email' && (
              <div className="space-y-2">
                <Label>Asunto</Label>
                <Input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="Asunto del email"
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>Contenido</Label>
              <Textarea
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="Hola {{nombre}}, tu pago de ${{monto}} está pendiente..."
                rows={6}
              />
              <p className="text-xs text-muted-foreground">
                Usa {"{{variable}}"} para campos dinámicos. Ej: {"{{nombre}}"}, {"{{monto}}"}, {"{{fecha}}"}
              </p>
            </div>

            {form.content && extractVariables(form.content).length > 0 && (
              <div className="p-3 bg-muted/30 rounded-lg">
                <p className="text-sm text-muted-foreground mb-2">Variables detectadas:</p>
                <div className="flex flex-wrap gap-1">
                  {extractVariables(form.content).map(v => (
                    <Badge key={v} variant="secondary">{v}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              <X className="h-4 w-4 mr-2" />
              Cancelar
            </Button>
            <Button onClick={handleSave}>
              <Save className="h-4 w-4 mr-2" />
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Vista Previa: {previewTemplate?.name}</DialogTitle>
          </DialogHeader>
          
          {previewTemplate && (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={channelConfig[previewTemplate.channel]?.color}>
                  {channelConfig[previewTemplate.channel]?.label}
                </Badge>
                <Badge variant="secondary">v{previewTemplate.version}</Badge>
              </div>
              
              {previewTemplate.subject && (
                <div>
                  <p className="text-sm text-muted-foreground">Asunto:</p>
                  <p className="font-medium">{previewTemplate.subject}</p>
                </div>
              )}
              
              <div>
                <p className="text-sm text-muted-foreground mb-2">Mensaje:</p>
                <div className="bg-muted/30 p-4 rounded-lg whitespace-pre-wrap">
                  {previewTemplate.content}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
