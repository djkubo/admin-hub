import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings, Save, ExternalLink, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

// Skeleton de carga
function GHLSkeleton() {
  return (
    <Card className="card-base">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-1">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </CardContent>
    </Card>
  );
}

export default function GHLSettingsPanel() {
  const [webhookUrl, setWebhookUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value, updated_at')
        .eq('key', 'ghl_webhook_url')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      
      if (data?.value) {
        setWebhookUrl(data.value);
        setLastSaved(data.updated_at);
      }
    } catch (error) {
      console.error('Error loading GHL settings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('system_settings')
        .upsert({
          key: 'ghl_webhook_url',
          value: webhookUrl,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (error) throw error;

      setLastSaved(new Date().toISOString());
      toast({
        title: "Configuración guardada",
        description: "La URL del webhook de GoHighLevel se actualizó correctamente.",
      });
    } catch (error) {
      console.error('Error saving GHL settings:', error);
      toast({
        title: "Error",
        description: "No se pudo guardar la configuración.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isValidUrl = webhookUrl.startsWith('https://');
  const isConfigured = !!webhookUrl && isValidUrl;

  if (isLoading) {
    return <GHLSkeleton />;
  }

  return (
    <Card className="card-base">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Integración GoHighLevel</CardTitle>
              <CardDescription>Conecta tu CRM para automatizar comunicaciones</CardDescription>
            </div>
          </div>
          <Badge variant={isConfigured ? "success" : "warning"}>
            {isConfigured ? (
              <><CheckCircle2 className="h-3 w-3 mr-1" /> Configurado</>
            ) : (
              <><AlertCircle className="h-3 w-3 mr-1" /> Pendiente</>
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="webhook-url">Webhook URL de GHL</Label>
          <div className="flex gap-2">
            <Input
              id="webhook-url"
              type="url"
              placeholder="https://services.leadconnectorhq.com/hooks/..."
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="flex-1 input-base"
            />
            <Button onClick={handleSave} disabled={isSaving || !webhookUrl} className="btn-primary">
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
            </Button>
          </div>
          {webhookUrl && !isValidUrl && (
            <p className="text-xs text-destructive">La URL debe comenzar con https://</p>
          )}
        </div>

        {lastSaved && (
          <p className="text-xs text-muted-foreground">
            Última actualización: {new Date(lastSaved).toLocaleString('es-MX')}
          </p>
        )}

        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <h4 className="text-sm font-medium mb-2">¿Cómo configurar?</h4>
          <ol className="text-xs text-muted-foreground space-y-1">
            <li>1. En GHL → Automation → Workflows → Crear nuevo</li>
            <li>2. Trigger: "Incoming Webhook" → Copiar la URL generada</li>
            <li>3. Pegar la URL arriba y guardar</li>
            <li>4. En GHL, añadir acciones: Create Contact, Add Tag, Send SMS</li>
          </ol>
          <a 
            href="https://help.gohighlevel.com/support/solutions/articles/48001181963-workflows-webhook-trigger"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
          >
            Ver documentación de GHL <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <h4 className="text-sm font-medium mb-2">Tags automáticos</h4>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="text-xs">payment_failed</Badge>
            <Badge variant="outline" className="text-xs">new_lead</Badge>
            <Badge variant="outline" className="text-xs">manual_push</Badge>
            <Badge variant="outline" className="text-xs">trial_started</Badge>
            <Badge variant="outline" className="text-xs">churn_risk</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Estos tags se envían automáticamente según la acción detectada.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// Named export for backwards compatibility
export { GHLSettingsPanel };
