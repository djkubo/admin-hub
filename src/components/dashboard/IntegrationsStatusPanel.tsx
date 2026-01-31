import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle, XCircle, RefreshCw, ExternalLink, Zap, CreditCard, MessageCircle, Users, Bot } from 'lucide-react';
import { invokeWithAdminKey } from '@/lib/adminApi';
import { toast } from 'sonner';

interface Integration {
  id: string;
  name: string;
  icon: React.ElementType;
  secrets: string[];
  testEndpoint?: string;
}

const integrations: Integration[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    icon: CreditCard,
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    testEndpoint: 'fetch-stripe',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    icon: CreditCard,
    secrets: ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_WEBHOOK_ID'],
    testEndpoint: 'fetch-paypal',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    icon: MessageCircle,
    secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
  },
  {
    id: 'ghl',
    name: 'GoHighLevel',
    icon: Users,
    secrets: ['GHL_API_KEY', 'GHL_LOCATION_ID'],
    testEndpoint: 'sync-ghl',
  },
  {
    id: 'manychat',
    name: 'ManyChat',
    icon: Bot,
    secrets: ['MANYCHAT_API_KEY'],
    testEndpoint: 'sync-manychat',
  },
];

export function IntegrationsStatusPanel() {
  const [testing, setTesting] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, 'connected' | 'error' | 'unknown'>>({});

  const testConnection = async (integration: Integration) => {
    if (!integration.testEndpoint) {
      toast.info('Esta integración no tiene prueba automática');
      return;
    }

    setTesting(integration.id);
    
    // Safety timeout to prevent infinite spinners (30 seconds)
    const timeoutId = setTimeout(() => {
      setTesting(null);
      setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
      toast.error(`${integration.name}: Timeout - sin respuesta después de 30s`);
    }, 30000);
    
    try {
      const result = await invokeWithAdminKey<{ success?: boolean; ok?: boolean; error?: string; testOnly?: boolean }>(
        integration.testEndpoint,
        { testOnly: true } // Fast health check mode - no sync, just API ping
      );

      clearTimeout(timeoutId);

      if (result?.success || result?.ok) {
        setStatuses(prev => ({ ...prev, [integration.id]: 'connected' }));
        toast.success(`${integration.name} conectado correctamente`);
      } else {
        setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
        toast.error(`${integration.name}: ${result?.error || 'Error de conexión'}`);
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
      const errorMsg = error?.message || 'Error de conexión';
      toast.error(`Error probando ${integration.name}: ${errorMsg}`);
    } finally {
      setTesting(null);
    }
  };

  const getStatusBadge = (integrationId: string) => {
    const status = statuses[integrationId];
    
    if (!status || status === 'unknown') {
      return (
        <Badge variant="neutral">
          Sin probar
        </Badge>
      );
    }
    
    if (status === 'connected') {
      return (
        <Badge variant="success">
          <CheckCircle className="h-3 w-3 mr-1" />
          Conectado
        </Badge>
      );
    }
    
    return (
      <Badge variant="error">
        <XCircle className="h-3 w-3 mr-1" />
        Error
      </Badge>
    );
  };

  return (
    <Card className="card-base">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Estado de Integraciones
        </CardTitle>
        <CardDescription>
          Verifica la conexión con APIs externas
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {integrations.map((integration) => {
          const Icon = integration.icon;
          return (
            <div
              key={integration.id}
              className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30"
            >
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5 text-zinc-400" />
                <div>
                  <p className="font-medium text-foreground">{integration.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {integration.secrets.length} secreto{integration.secrets.length > 1 ? 's' : ''} configurado{integration.secrets.length > 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {getStatusBadge(integration.id)}
                
                {integration.testEndpoint && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => testConnection(integration)}
                    disabled={testing === integration.id}
                    className="h-8 px-2"
                  >
                    {testing === integration.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        <div className="pt-2 border-t border-border/30">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <ExternalLink className="h-3 w-3" />
            Para rotar claves, usa la configuración de Lovable Cloud
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
