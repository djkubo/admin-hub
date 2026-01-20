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
    <div className="space-y-4 sm:space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-4">
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-1.5 sm:p-2 rounded-lg bg-blue-500/10 shrink-0">
                <Users className="h-4 w-4 sm:h-5 sm:w-5 text-blue-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] sm:text-sm text-muted-foreground">Leads</p>
                <p className="text-lg sm:text-2xl font-bold text-white">{totals.leads.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-1.5 sm:p-2 rounded-lg bg-amber-500/10 shrink-0">
                <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-amber-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] sm:text-sm text-muted-foreground">En Trial</p>
                <p className="text-lg sm:text-2xl font-bold text-white">{totals.trials.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-1.5 sm:p-2 rounded-lg bg-green-500/10 shrink-0">
                <Target className="h-4 w-4 sm:h-5 sm:w-5 text-green-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] sm:text-sm text-muted-foreground">Clientes</p>
                <p className="text-lg sm:text-2xl font-bold text-white">{totals.customers.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-1.5 sm:p-2 rounded-lg bg-primary/10 shrink-0">
                <DollarSign className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] sm:text-sm text-muted-foreground">Rev 30d</p>
                <p className="text-lg sm:text-2xl font-bold text-white">${totals.revenue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Analytics */}
      <Card className="bg-card border-border">
        <CardHeader className="p-3 sm:p-6 pb-2 sm:pb-4">
          <CardTitle className="text-white flex items-center gap-2 text-sm sm:text-base">
            <Target className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            Analytics por Fuente
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Atribución por canal
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
              <TabsList className="mb-3 sm:mb-4 w-max sm:w-auto">
                <TabsTrigger value="overview" className="text-xs sm:text-sm px-2 sm:px-3">Overview</TabsTrigger>
                <TabsTrigger value="revenue" className="text-xs sm:text-sm px-2 sm:px-3">Revenue</TabsTrigger>
                <TabsTrigger value="conversion" className="text-xs sm:text-sm px-2 sm:px-3">Convers.</TabsTrigger>
                <TabsTrigger value="ltv" className="text-xs sm:text-sm px-2 sm:px-3">LTV</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview">
              <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
                {/* Bar Chart */}
                <div className="h-[200px] sm:h-80">
                  <ChartContainer config={{}}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={metrics.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 10 }}>
                        <XAxis type="number" stroke="#6b7280" fontSize={10} />
                        <YAxis 
                          dataKey="source" 
                          type="category" 
                          stroke="#6b7280" 
                          fontSize={10}
                          width={60}
                          tickFormatter={(value) => value.length > 8 ? value.slice(0, 8) + '...' : value}
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
                <div className="h-[200px] sm:h-80">
                  <ChartContainer config={{}}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          outerRadius={60}
                          label={({ name, percent }) => `${name.slice(0,6)}: ${(percent * 100).toFixed(0)}%`}
                          labelLine={false}
                        >
                          {pieData.map((_, index) => (
                            <Cell key={index} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Legend wrapperStyle={{ fontSize: '10px' }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </ChartContainer>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="revenue">
              <div className="h-[200px] sm:h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.slice(0, 10)} margin={{ left: 0, right: 10, bottom: 40 }}>
                      <XAxis 
                        dataKey="source" 
                        stroke="#6b7280" 
                        fontSize={10} 
                        angle={-45}
                        textAnchor="end"
                        height={60}
                        tickFormatter={(value) => value.length > 8 ? value.slice(0, 8) + '...' : value}
                      />
                      <YAxis stroke="#6b7280" fontSize={10} width={40} />
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
              <div className="h-[200px] sm:h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.slice(0, 10)} margin={{ left: 0, right: 10, bottom: 40 }}>
                      <XAxis 
                        dataKey="source" 
                        stroke="#6b7280" 
                        fontSize={10}
                        angle={-45}
                        textAnchor="end"
                        height={60}
                        tickFormatter={(value) => value.length > 8 ? value.slice(0, 8) + '...' : value}
                      />
                      <YAxis stroke="#6b7280" fontSize={10} unit="%" width={35} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="conversionRate" name="Lead→Paid" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="trialToPaid" name="Trial→Paid" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </div>
            </TabsContent>

            <TabsContent value="ltv">
              <div className="h-[200px] sm:h-80">
                <ChartContainer config={{}}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={metrics.filter(m => m.ltv > 0).slice(0, 10)} margin={{ left: 0, right: 10, bottom: 40 }}>
                      <XAxis 
                        dataKey="source" 
                        stroke="#6b7280" 
                        fontSize={10}
                        angle={-45}
                        textAnchor="end"
                        height={60}
                        tickFormatter={(value) => value.length > 8 ? value.slice(0, 8) + '...' : value}
                      />
                      <YAxis stroke="#6b7280" fontSize={10} width={40} />
                      <ChartTooltip 
                        content={<ChartTooltipContent />}
                        formatter={(value) => [`$${Number(value).toLocaleString()}`, 'LTV']}
                      />
                      <Bar dataKey="ltv" name="LTV" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </div>
            </TabsContent>
          </Tabs>

          {/* Table - Mobile optimized */}
          <div className="mt-4 sm:mt-6 overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
            <table className="w-full text-xs sm:text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium sticky left-0 bg-card">Fuente</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium">Leads</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium">Trial</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium">Client</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium hidden sm:table-cell">Conv%</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium hidden sm:table-cell">LTV</th>
                  <th className="text-right py-2 sm:py-3 px-1 sm:px-2 text-muted-foreground font-medium">Rev</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((row, idx) => (
                  <tr key={row.source} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="py-2 sm:py-3 px-1 sm:px-2 sticky left-0 bg-card">
                      <Badge 
                        variant="outline" 
                        className="text-[10px] sm:text-xs"
                        style={{ borderColor: COLORS[idx % COLORS.length], color: COLORS[idx % COLORS.length] }}
                      >
                        {row.source.length > 10 ? row.source.slice(0, 10) + '...' : row.source}
                      </Badge>
                    </td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-white">{row.leads}</td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-amber-400">{row.trials}</td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-green-400">{row.customers}</td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-blue-400 hidden sm:table-cell">{row.conversionRate}%</td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-amber-400 hidden sm:table-cell">${row.ltv}</td>
                    <td className="text-right py-2 sm:py-3 px-1 sm:px-2 text-green-400 font-medium">${row.revenue}</td>
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
