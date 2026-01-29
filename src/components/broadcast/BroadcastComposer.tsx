import React, { useState } from 'react';
import { Send, Image, Video, FileText, Clock, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useBroadcastList,
  useBroadcastListMembers,
  useSendBroadcast,
} from '@/hooks/useBroadcastLists';

interface BroadcastComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listId: string | null;
}

const VARIABLES = [
  { key: '{{name}}', label: 'Nombre', description: 'Nombre del contacto' },
  { key: '{{phone}}', label: 'Teléfono', description: 'Número de teléfono' },
  { key: '{{email}}', label: 'Email', description: 'Correo electrónico' },
];

export function BroadcastComposer({ open, onOpenChange, listId }: BroadcastComposerProps) {
  const { data: list } = useBroadcastList(listId);
  const { data: members } = useBroadcastListMembers(listId);
  const sendMutation = useSendBroadcast();

  const [message, setMessage] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<string>('');
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');

  const insertVariable = (variable: string) => {
    setMessage((prev) => prev + variable);
  };

  const getPreviewMessage = () => {
    return message
      .replace('{{name}}', 'Juan Pérez')
      .replace('{{phone}}', '+52 55 1234 5678')
      .replace('{{email}}', 'juan@ejemplo.com');
  };

  const handleSend = async () => {
    if (!listId || !message.trim()) return;

    let scheduledAt: string | undefined;
    if (isScheduled && scheduledDate && scheduledTime) {
      scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
    }

    await sendMutation.mutateAsync({
      listId,
      messageContent: message,
      mediaUrl: mediaUrl || undefined,
      mediaType: mediaType || undefined,
      scheduledAt,
    });

    setMessage('');
    setMediaUrl('');
    setMediaType('');
    setIsScheduled(false);
    setScheduledDate('');
    setScheduledTime('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            Enviar Difusión
          </DialogTitle>
          <DialogDescription>
            Compón y envía un mensaje a todos los miembros de {list?.name || 'la lista'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Recipients Info */}
          <div className="flex items-center gap-2 p-3 rounded-lg bg-muted">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">
              Se enviará a <strong>{members?.length || 0}</strong> contactos
            </span>
          </div>

          {/* Message */}
          <div className="space-y-2">
            <Label>Mensaje</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escribe tu mensaje aquí...&#10;&#10;Usa variables como {{name}} para personalizar"
              rows={5}
              className="resize-none"
            />
            
            {/* Variables */}
            <div className="flex flex-wrap gap-1">
              {VARIABLES.map((v) => (
                <Badge
                  key={v.key}
                  variant="outline"
                  className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors"
                  onClick={() => insertVariable(v.key)}
                >
                  {v.label}
                </Badge>
              ))}
            </div>
          </div>

          {/* Media Attachment */}
          <div className="space-y-2">
            <Label>Multimedia (opcional)</Label>
            <div className="flex gap-2">
              <Input
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
                placeholder="URL del archivo multimedia..."
                className="flex-1"
              />
              <Select value={mediaType} onValueChange={setMediaType}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">
                    <div className="flex items-center gap-2">
                      <Image className="h-4 w-4" />
                      Imagen
                    </div>
                  </SelectItem>
                  <SelectItem value="video">
                    <div className="flex items-center gap-2">
                      <Video className="h-4 w-4" />
                      Video
                    </div>
                  </SelectItem>
                  <SelectItem value="document">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Documento
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Schedule */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="schedule">Programar envío</Label>
              </div>
              <Switch
                id="schedule"
                checked={isScheduled}
                onCheckedChange={setIsScheduled}
              />
            </div>
            
            {isScheduled && (
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="flex-1"
                />
                <Input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="w-32"
                />
              </div>
            )}
          </div>

          {/* Preview */}
          {message && (
            <div className="space-y-2">
              <Label>Vista previa</Label>
              <div className="p-4 rounded-lg bg-muted border">
                <p className="text-sm whitespace-pre-wrap">{getPreviewMessage()}</p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleSend}
            disabled={!message.trim() || sendMutation.isPending}
          >
            {sendMutation.isPending ? (
              <>Enviando...</>
            ) : isScheduled ? (
              <>
                <Clock className="h-4 w-4 mr-2" />
                Programar
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Enviar Ahora
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
