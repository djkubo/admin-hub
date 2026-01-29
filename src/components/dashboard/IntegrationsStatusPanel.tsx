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
  color: string;
}

const integrations: Integration[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    icon: CreditCard,
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    testEndpoint: 'fetch-stripe',
    color: 'purple',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    icon: CreditCard,
    secrets: ['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_WEBHOOK_ID'],
    testEndpoint: 'fetch-paypal',
    color: 'blue',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    icon: MessageCircle,
    secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
    color: 'red',
  },
  {
    id: 'ghl',
    name: 'GoHighLevel',
    icon: Users,
    secrets: ['GHL_API_KEY', 'GHL_LOCATION_ID'],
    testEndpoint: 'sync-ghl',
    color: 'green',
  },
  {
    id: 'manychat',
    name: 'ManyChat',
    icon: Bot,
    secrets: ['MANYCHAT_API_KEY'],
    testEndpoint: 'sync-manychat',
    color: 'cyan',
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
    
    try {
      const result = await invokeWithAdminKey<{ success?: boolean; ok?: boolean; error?: string }>(
        integration.testEndpoint,
        { dryRun: true, limit: 1 }
      );

      if (result?.success || result?.ok) {
        setStatuses(prev => ({ ...prev, [integration.id]: 'connected' }));
        toast.success(`${integration.name} conectado correctamente`);
      } else {
        setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
        toast.error(`${integration.name}: ${result?.error || 'Error de conexión'}`);
      }
    } catch (error) {
      setStatuses(prev => ({ ...prev, [integration.id]: 'error' }));
      toast.error(`Error probando ${integration.name}`);
    } finally {
      setTesting(null);
    }
  };

  const getStatusBadge = (integrationId: string) => {
    const status = statuses[integrationId];
    
    if (!status || status === 'unknown') {
      return (
        <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-muted">
          Sin probar
        </Badge>
      );
    }
    
    if (status === 'connected') {
      return (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
          <CheckCircle className="h-3 w-3 mr-1" />
          Conectado
        </Badge>
      );
    }
    
    return (
      <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30">
        <XCircle className="h-3 w-3 mr-1" />
        Error
      </Badge>
    );
  };

  const getColorClasses = (color: string) => {
    const colors: Record<string, string> = {
      purple: 'text-purple-400',
      blue: 'text-blue-400',
      red: 'text-red-400',
      green: 'text-green-400',
      cyan: 'text-cyan-400',
    };
    return colors[color] || 'text-primary';
  };

  return (
    <Card className="bg-card border-border/50">
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
                <Icon className={`h-5 w-5 ${getColorClasses(integration.color)}`} />
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
