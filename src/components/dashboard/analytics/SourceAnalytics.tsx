import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Target, TrendingUp, DollarSign, Users, Loader2 } from 'lucide-react';

interface SourceMetrics {
  source: string;
  leads: number;
  trials: number;
  customers: number;
  revenue: number;
  ltv: number;
  conversionRate: number;
  trialToPaid: number;
}

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export function SourceAnalytics() {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<SourceMetrics[]>([]);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    fetchSourceMetrics();
  }, []);

  const fetchSourceMetrics = async () => {
    setLoading(true);
    try {
      // Get all clients with acquisition_source
      const { data: clients } = await supabase
        .from('clients')
        .select('id, acquisition_source, lifecycle_stage, total_spend');

      // Get transactions for revenue calculation (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: transactions } = await supabase
        .from('transactions')
        .select('customer_email, amount, status, currency')
        .eq('status', 'succeeded')
        .gte('created_at', thirtyDaysAgo);

      if (!clients) {
        setMetrics([]);
        return;
      }

      // Build email to source mapping
      const { data: clientsWithEmail } = await supabase
        .from('clients')
        .select('email, acquisition_source');

      const emailToSource: Record<string, string> = {};
      clientsWithEmail?.forEach(c => {
        if (c.email && c.acquisition_source) {
          emailToSource[c.email.toLowerCase()] = c.acquisition_source;
        }
      });

      // Aggregate by source
      const sourceMap = new Map<string, {
        leads: number;
        trials: number;
        customers: number;
        revenue: number;
        totalSpend: number;
        customerCount: number;
      }>();

      clients.forEach(client => {
        const source = client.acquisition_source || 'unknown';
        if (!sourceMap.has(source)) {
          sourceMap.set(source, { leads: 0, trials: 0, customers: 0, revenue: 0, totalSpend: 0, customerCount: 0 });
        }
        const data = sourceMap.get(source)!;
        
        if (client.lifecycle_stage === 'LEAD') data.leads++;
        else if (client.lifecycle_stage === 'TRIAL') data.trials++;
        else if (client.lifecycle_stage === 'CUSTOMER') {
          data.customers++;
          data.customerCount++;
          data.totalSpend += client.total_spend || 0;
        }
      });

      // Add transaction revenue
      transactions?.forEach(tx => {
        if (tx.customer_email) {
          const source = emailToSource[tx.customer_email.toLowerCase()] || 'unknown';
          if (!sourceMap.has(source)) {
            sourceMap.set(source, { leads: 0, trials: 0, customers: 0, revenue: 0, totalSpend: 0, customerCount: 0 });
          }
          // Convert to USD (rough MXN conversion)
          let amountUSD = (tx.amount || 0) / 100;
          if (tx.currency === 'mxn') amountUSD = amountUSD / 17;
          sourceMap.get(source)!.revenue += amountUSD;
        }
      });

      // Convert to array and calculate derived metrics
      const result: SourceMetrics[] = Array.from(sourceMap.entries())
        .map(([source, data]) => {
          const totalPipeline = data.leads + data.trials + data.customers;
          return {
            source,
            leads: data.leads,
            trials: data.trials,
            customers: data.customers,
            revenue: Math.round(data.revenue),
            ltv: data.customerCount > 0 ? Math.round(data.totalSpend / data.customerCount / 100) : 0,
            conversionRate: totalPipeline > 0 ? Math.round((data.customers / totalPipeline) * 100) : 0,
            trialToPaid: data.trials + data.customers > 0 
              ? Math.round((data.customers / (data.trials + data.customers)) * 100) 
              : 0,
          };
        })
        .filter(m => m.leads + m.trials + m.customers > 0)
        .sort((a, b) => b.revenue - a.revenue);

      setMetrics(result);
    } catch (error) {
      console.error('Error fetching source metrics:', error);
    }
    setLoading(false);
  };

  const totals = useMemo(() => {
    return metrics.reduce((acc, m) => ({
      leads: acc.leads + m.leads,
      trials: acc.trials + m.trials,
      customers: acc.customers + m.customers,
      revenue: acc.revenue + m.revenue,
    }), { leads: 0, trials: 0, customers: 0, revenue: 0 });
  }, [metrics]);

  const pieData = useMemo(() => {
    return metrics.slice(0, 6).map(m => ({
      name: m.source,
      value: m.revenue,
    }));
  }, [metrics]);

  if (loading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Users className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Leads Totales</p>
                <p className="text-2xl font-bold text-white">{totals.leads.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <TrendingUp className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">En Trial</p>
                <p className="text-2xl font-bold text-white">{totals.trials.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Target className="h-5 w-5 text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Clientes</p>
                <p className="text-2xl font-bold text-white">{totals.customers.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <DollarSign className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Revenue 30d</p>
                <p className="text-2xl font-bold text-white">${totals.revenue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Analytics */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            Analytics por Fuente de Adquisición
          </CardTitle>
          <CardDescription>
            Atribución de leads, conversiones y revenue por canal
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="revenue">Revenue</TabsTrigger>
              <TabsTrigger value="conversion">Conversión</TabsTrigger>
              <TabsTrigger value="ltv">LTV</TabsTrigger>
            </TabsList>

            <TabsContent value="overview">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Bar Chart */}
                <div className="h-80">
                  <ChartContainer config={{}}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={metrics.slice(0, 8)} layout="vertical">
                        <XAxis type="number" stroke="#6b7280" fontSize={12} />
                        <YAxis 
                          dataKey="source" 
                          type="category" 
                          stroke="#6b7280" 
                          fontSize={12}
                          width={80}
                        />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="leads" name="Leads" fill="#3b82f6" stackId="stack" />
                        <Bar dataKey="trials" name="Trials" fill="#f59e0b" stackId="stack" />
                        <Bar dataKey="customers" name="Clientes" fill="#22c55e" stackId="stack" />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>

                {/* Pie Chart */}
                <div className="h-80">
                  <ChartContainer config={{}}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                        >
                          {pieData.map((_, index) => (
                            <Cell key={index} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="revenue">
              <div className="h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.slice(0, 10)}>
                      <XAxis dataKey="source" stroke="#6b7280" fontSize={12} />
                      <YAxis stroke="#6b7280" fontSize={12} />
                      <ChartTooltip 
                        content={<ChartTooltipContent />}
                        formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Revenue 30d']}
                      />
                      <Bar dataKey="revenue" name="Revenue 30d" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </div>
            </TabsContent>

            <TabsContent value="conversion">
              <div className="h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.slice(0, 10)}>
                      <XAxis dataKey="source" stroke="#6b7280" fontSize={12} />
                      <YAxis stroke="#6b7280" fontSize={12} unit="%" />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="conversionRate" name="Lead→Paid %" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="trialToPaid" name="Trial→Paid %" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </div>
            </TabsContent>

            <TabsContent value="ltv">
              <div className="h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.filter(m => m.ltv > 0).slice(0, 10)}>
                      <XAxis dataKey="source" stroke="#6b7280" fontSize={12} />
                      <YAxis stroke="#6b7280" fontSize={12} />
                      <ChartTooltip 
                        content={<ChartTooltipContent />}
                        formatter={(value) => [`$${Number(value).toLocaleString()}`, 'LTV Promedio']}
                      />
                      <Bar dataKey="ltv" name="LTV Promedio" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </div>
            </TabsContent>
          </Tabs>

          {/* Table */}
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-2 text-muted-foreground font-medium">Fuente</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Leads</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Trials</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Clientes</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Conv %</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Trial→Paid</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">LTV</th>
                  <th className="text-right py-3 px-2 text-muted-foreground font-medium">Revenue 30d</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((row, idx) => (
                  <tr key={row.source} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-3 px-2">
                      <Badge 
                        variant="outline" 
                        style={{ borderColor: COLORS[idx % COLORS.length], color: COLORS[idx % COLORS.length] }}
                      >
                        {row.source}
                      </Badge>
                    </td>
                    <td className="text-right py-3 px-2 text-white">{row.leads.toLocaleString()}</td>
                    <td className="text-right py-3 px-2 text-amber-400">{row.trials.toLocaleString()}</td>
                    <td className="text-right py-3 px-2 text-green-400">{row.customers.toLocaleString()}</td>
                    <td className="text-right py-3 px-2 text-blue-400">{row.conversionRate}%</td>
                    <td className="text-right py-3 px-2 text-purple-400">{row.trialToPaid}%</td>
                    <td className="text-right py-3 px-2 text-amber-400">${row.ltv.toLocaleString()}</td>
                    <td className="text-right py-3 px-2 text-green-400 font-medium">${row.revenue.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
