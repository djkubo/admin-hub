import { useMemo } from 'react';
import { AlertTriangle, Phone, Mail, Users, FileWarning, CheckCircle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { Client } from '@/hooks/useClients';

interface DataHealthPanelProps {
  clients: Client[];
  transactions: Array<{ customer_email: string | null; status: string }>;
}

interface HealthMetric {
  label: string;
  value: number;
  total: number;
  percentage: number;
  icon: typeof Phone;
  color: string;
  isGood: boolean;
}

export function DataHealthPanel({ clients, transactions }: DataHealthPanelProps) {
  const metrics = useMemo((): HealthMetric[] => {
    const totalClients = clients.length;
    
    // Clients without phone
    const withoutPhone = clients.filter(c => !c.phone || c.phone.trim() === '').length;
    const withPhonePercent = totalClients > 0 ? ((totalClients - withoutPhone) / totalClients) * 100 : 100;
    
    // Clients without email
    const withoutEmail = clients.filter(c => !c.email || c.email.trim() === '').length;
    const withEmailPercent = totalClients > 0 ? ((totalClients - withoutEmail) / totalClients) * 100 : 100;
    
    // Transactions without email
    const txWithoutEmail = transactions.filter(t => !t.customer_email || t.customer_email.trim() === '').length;
    const txWithEmailPercent = transactions.length > 0 ? ((transactions.length - txWithoutEmail) / transactions.length) * 100 : 100;
    
    // Duplicate phones (same phone, different emails)
    const phoneMap = new Map<string, Set<string>>();
    clients.forEach(c => {
      if (c.phone && c.email) {
        const phone = c.phone.replace(/\D/g, '');
        if (phone.length >= 10) {
          if (!phoneMap.has(phone)) {
            phoneMap.set(phone, new Set());
          }
          phoneMap.get(phone)!.add(c.email);
        }
      }
    });
    const duplicatePhones = Array.from(phoneMap.values()).filter(emails => emails.size > 1).length;
    const noDuplicatesPercent = totalClients > 0 ? ((totalClients - duplicatePhones * 2) / totalClients) * 100 : 100;
    
    return [
      {
        label: 'Con Teléfono',
        value: totalClients - withoutPhone,
        total: totalClients,
        percentage: withPhonePercent,
        icon: Phone,
        color: withPhonePercent >= 80 ? 'emerald' : withPhonePercent >= 50 ? 'amber' : 'red',
        isGood: withPhonePercent >= 80,
      },
      {
        label: 'Con Email',
        value: totalClients - withoutEmail,
        total: totalClients,
        percentage: withEmailPercent,
        icon: Mail,
        color: withEmailPercent >= 90 ? 'emerald' : withEmailPercent >= 70 ? 'amber' : 'red',
        isGood: withEmailPercent >= 90,
      },
      {
        label: 'Pagos con Email',
        value: transactions.length - txWithoutEmail,
        total: transactions.length,
        percentage: txWithEmailPercent,
        icon: FileWarning,
        color: txWithEmailPercent >= 95 ? 'emerald' : txWithEmailPercent >= 80 ? 'amber' : 'red',
        isGood: txWithEmailPercent >= 95,
      },
      {
        label: 'Sin Duplicados Tel.',
        value: totalClients - duplicatePhones * 2,
        total: totalClients,
        percentage: Math.max(0, noDuplicatesPercent),
        icon: Users,
        color: duplicatePhones === 0 ? 'emerald' : duplicatePhones <= 5 ? 'amber' : 'red',
        isGood: duplicatePhones === 0,
      },
    ];
  }, [clients, transactions]);

  const overallHealth = useMemo(() => {
    const avg = metrics.reduce((sum, m) => sum + m.percentage, 0) / metrics.length;
    return Math.round(avg);
  }, [metrics]);

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; progress: string }> = {
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', progress: 'bg-emerald-500' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400', progress: 'bg-amber-500' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400', progress: 'bg-red-500' },
    };
    return colors[color] || colors.amber;
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${overallHealth >= 80 ? 'bg-emerald-500/10' : overallHealth >= 60 ? 'bg-amber-500/10' : 'bg-red-500/10'}`}>
            {overallHealth >= 80 ? (
              <CheckCircle className="h-5 w-5 text-emerald-500" />
            ) : (
              <AlertTriangle className={`h-5 w-5 ${overallHealth >= 60 ? 'text-amber-500' : 'text-red-500'}`} />
            )}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Data Health</h3>
            <p className="text-sm text-muted-foreground">Calidad de datos de clientes</p>
          </div>
        </div>
        <div className="text-right">
          <p className={`text-2xl font-bold ${overallHealth >= 80 ? 'text-emerald-400' : overallHealth >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
            {overallHealth}%
          </p>
          <p className="text-xs text-muted-foreground">Salud general</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.map((metric, index) => {
          const colors = getColorClasses(metric.color);
          const Icon = metric.icon;

          return (
            <div key={index} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded ${colors.bg}`}>
                    <Icon className={`h-3.5 w-3.5 ${colors.text}`} />
                  </div>
                  <span className="text-xs text-muted-foreground">{metric.label}</span>
                </div>
                <span className={`text-sm font-medium ${colors.text}`}>
                  {metric.percentage.toFixed(0)}%
                </span>
              </div>
              <Progress 
                value={metric.percentage} 
                className="h-1.5"
              />
              <p className="text-[10px] text-muted-foreground">
                {metric.value} de {metric.total}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
