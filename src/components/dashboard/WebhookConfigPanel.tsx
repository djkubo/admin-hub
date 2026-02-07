import { useState } from 'react';
import { Copy, Check, Webhook, Shield, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { env } from '@/lib/env';

const SUPABASE_URL = env.VITE_SUPABASE_URL || '';

export function WebhookConfigPanel() {
  const [copiedItem, setCopiedItem] = useState<string | null>(null);
  
  const webhookUrl = `${SUPABASE_URL}/functions/v1/receive-lead`;
  
  const copyToClipboard = async (text: string, item: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedItem(item);
    setTimeout(() => setCopiedItem(null), 2000);
    toast.success('Copiado al portapapeles');
  };

  const curlExample = `curl -X POST "${webhookUrl}" \\
  -H "Content-Type: application/json" \\
  -H "X-ADMIN-KEY: YOUR_ADMIN_API_KEY" \\
  -d '{
    "event_id": "unique_event_123",
    "source": "manychat_instagram",
    "email": "lead@example.com",
    "phone": "+521234567890",
    "full_name": "Juan Pérez",
    "utm_source": "instagram",
    "utm_medium": "organic",
    "utm_campaign": "summer_2024"
  }'`;

  const manychatPayload = `{
  "event_id": "{{subscriber_id}}",
  "source": "manychat_{{channel}}",
  "email": "{{email}}",
  "phone": "{{phone}}",
  "full_name": "{{first_name}} {{last_name}}",
  "external_manychat_id": "{{subscriber_id}}",
  "utm_source": "{{custom_field.utm_source}}",
  "utm_medium": "{{custom_field.utm_medium}}",
  "utm_campaign": "{{custom_field.utm_campaign}}"
}`;

  const ghlPayload = `{
  "event_id": "{{contact.id}}",
  "source": "ghl_{{contact.source}}",
  "email": "{{contact.email}}",
  "phone": "{{contact.phone}}",
  "full_name": "{{contact.name}}",
  "external_ghl_id": "{{contact.id}}",
  "utm_source": "{{contact.customField.utm_source}}",
  "utm_campaign": "{{contact.customField.utm_campaign}}",
  "tags": ["{{#each contact.tags}}{{this}}{{/each}}"]
}`;

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-white">
          <Webhook className="h-5 w-5 text-primary" />
          Configuración de Webhook para Leads
        </CardTitle>
        <CardDescription>
          Conecta ManyChat, GoHighLevel u otros sistemas para recibir leads
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Endpoint URL */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground">Endpoint URL</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 p-3 bg-muted/50 rounded-lg text-sm text-foreground break-all">
              {webhookUrl}
            </code>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => copyToClipboard(webhookUrl, 'url')}
            >
              {copiedItem === 'url' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Security Header */}
        <div className="space-y-2">
          <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Header de Autenticación (requerido)
          </label>
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <code className="text-sm text-amber-400">X-ADMIN-KEY: [tu ADMIN_API_KEY]</code>
            <p className="text-xs text-muted-foreground mt-2">
              El valor debe coincidir con el secret ADMIN_API_KEY configurado en Supabase.
              Sin este header, el webhook retornará 401 Unauthorized.
            </p>
          </div>
        </div>

        {/* Integration Examples */}
        <Tabs defaultValue="curl" className="space-y-4">
          <TabsList>
            <TabsTrigger value="curl" className="gap-2">
              <Code2 className="h-4 w-4" />
              cURL
            </TabsTrigger>
            <TabsTrigger value="manychat">ManyChat</TabsTrigger>
            <TabsTrigger value="ghl">GoHighLevel</TabsTrigger>
          </TabsList>

          <TabsContent value="curl" className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Ejemplo de prueba:</span>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => copyToClipboard(curlExample, 'curl')}
              >
                {copiedItem === 'curl' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                Copiar
              </Button>
            </div>
            <pre className="p-4 bg-muted/30 rounded-lg text-xs overflow-x-auto">
              {curlExample}
            </pre>
          </TabsContent>

          <TabsContent value="manychat" className="space-y-3">
            <div className="space-y-2">
              <h4 className="font-medium text-white">Configuración en ManyChat:</h4>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Ve a <strong>Automation → External Request</strong></li>
                <li>Método: <Badge variant="outline">POST</Badge></li>
                <li>URL: <code className="text-xs bg-muted p-1 rounded">{webhookUrl}</code></li>
                <li>Headers: <code className="text-xs bg-muted p-1 rounded">X-ADMIN-KEY: tu_key</code></li>
                <li>Body (JSON):</li>
              </ol>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Payload sugerido:</span>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => copyToClipboard(manychatPayload, 'manychat')}
              >
                {copiedItem === 'manychat' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                Copiar
              </Button>
            </div>
            <pre className="p-4 bg-muted/30 rounded-lg text-xs overflow-x-auto">
              {manychatPayload}
            </pre>
          </TabsContent>

          <TabsContent value="ghl" className="space-y-3">
            <div className="space-y-2">
              <h4 className="font-medium text-white">Configuración en GoHighLevel:</h4>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Ve a <strong>Automation → Webhooks</strong></li>
                <li>Trigger: Contact Created / Contact Updated</li>
                <li>Método: <Badge variant="outline">POST</Badge></li>
                <li>URL: <code className="text-xs bg-muted p-1 rounded">{webhookUrl}</code></li>
                <li>Headers: <code className="text-xs bg-muted p-1 rounded">X-ADMIN-KEY: tu_key</code></li>
              </ol>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Payload sugerido:</span>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => copyToClipboard(ghlPayload, 'ghl')}
              >
                {copiedItem === 'ghl' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                Copiar
              </Button>
            </div>
            <pre className="p-4 bg-muted/30 rounded-lg text-xs overflow-x-auto">
              {ghlPayload}
            </pre>
          </TabsContent>
        </Tabs>

        {/* Field Reference */}
        <div className="space-y-2">
          <h4 className="font-medium text-white">Campos soportados:</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="destructive" className="text-xs">req</Badge>
              <code>email</code> o <code>phone</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>event_id</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>source</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>full_name</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>utm_source</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>utm_campaign</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>utm_medium</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>external_manychat_id</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>external_ghl_id</code>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">opt</Badge>
              <code>tags[]</code>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
