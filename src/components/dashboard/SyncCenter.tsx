import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { 
  RefreshCw, 
  Play, 
  CheckCircle, 
  XCircle, 
  AlertTriangle,
  Database,
  Users,
  MessageSquare,
  Zap,
  Eye,
  Clock,
  ArrowRight,
  Loader2
} from "lucide-react";
import { format } from "date-fns";

interface SyncRun {
  id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_fetched: number;
  total_inserted: number;
  total_updated: number;
  total_skipped: number;
  total_conflicts: number;
  dry_run: boolean;
  error_message: string | null;
}

interface MergeConflict {
  id: string;
  source: string;
  external_id: string;
  email_found: string | null;
  phone_found: string | null;
  conflict_type: string;
  raw_data: any;
  suggested_client_id: string | null;
  status: string;
  created_at: string;
}

interface ContactIdentity {
  id: string;
  source: string;
  external_id: string;
  email_normalized: string | null;
  phone_e164: string | null;
  client_id: string | null;
  created_at: string;
}

const SOURCE_ICONS: Record<string, any> = {
  ghl: Zap,
  manychat: MessageSquare,
  stripe: Database,
  paypal: Database,
  web: Users,
  csv: Database
};

const SOURCE_LABELS: Record<string, string> = {
  ghl: 'GoHighLevel',
  manychat: 'ManyChat',
  stripe: 'Stripe',
  paypal: 'PayPal',
  web: 'Web/Scraper',
  csv: 'CSV Import'
};

export default function SyncCenter() {
  const queryClient = useQueryClient();
  const [dryRun, setDryRun] = useState(true);
  const [syncingSource, setSyncingSource] = useState<string | null>(null);

  // Fetch sync runs
  const { data: syncRuns = [], isLoading: loadingRuns } = useQuery({
    queryKey: ['sync-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as SyncRun[];
    }
  });

  // Fetch conflicts
  const { data: conflicts = [], isLoading: loadingConflicts } = useQuery({
    queryKey: ['merge-conflicts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merge_conflicts')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as MergeConflict[];
    }
  });

  // Fetch identity stats
  const { data: identityStats } = useQuery({
    queryKey: ['identity-stats'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contact_identities')
        .select('source')
        .limit(10000);
      if (error) throw error;
      
      const counts: Record<string, number> = {};
      data.forEach((row: any) => {
        counts[row.source] = (counts[row.source] || 0) + 1;
      });
      return counts;
    }
  });

  // Sync GHL mutation
  const syncGHL = useMutation({
    mutationFn: async () => {
      setSyncingSource('ghl');
      const { data, error } = await supabase.functions.invoke('sync-ghl', {
        body: { dry_run: dryRun }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setSyncingSource(null);
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
      queryClient.invalidateQueries({ queryKey: ['merge-conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['identity-stats'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      
      const stats = data.stats;
      toast.success(
        dryRun 
          ? `[Dry Run] GHL: ${stats.total_fetched} contacts, ${stats.total_inserted} nuevos, ${stats.total_updated} actualizados`
          : `GHL sincronizado: ${stats.total_inserted} nuevos, ${stats.total_updated} actualizados, ${stats.total_conflicts} conflictos`
      );
    },
    onError: (error: any) => {
      setSyncingSource(null);
      toast.error(`Error sincronizando GHL: ${error.message}`);
    }
  });

  // Sync ManyChat mutation
  const syncManyChat = useMutation({
    mutationFn: async () => {
      setSyncingSource('manychat');
      const { data, error } = await supabase.functions.invoke('sync-manychat', {
        body: { dry_run: dryRun }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setSyncingSource(null);
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
      queryClient.invalidateQueries({ queryKey: ['merge-conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['identity-stats'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      
      const stats = data.stats;
      toast.success(
        dryRun 
          ? `[Dry Run] ManyChat: ${stats.total_fetched} subscribers, ${stats.total_inserted} nuevos, ${stats.total_updated} actualizados`
          : `ManyChat sincronizado: ${stats.total_inserted} nuevos, ${stats.total_updated} actualizados, ${stats.total_conflicts} conflictos`
      );
    },
    onError: (error: any) => {
      setSyncingSource(null);
      toast.error(`Error sincronizando ManyChat: ${error.message}`);
    }
  });

  // Sync All mutation
  const syncAll = useMutation({
    mutationFn: async () => {
      setSyncingSource('all');
      
      // Run syncs in parallel
      const results = await Promise.allSettled([
        supabase.functions.invoke('sync-ghl', { body: { dry_run: dryRun } }),
        supabase.functions.invoke('sync-manychat', { body: { dry_run: dryRun } })
      ]);
      
      return results;
    },
    onSuccess: () => {
      setSyncingSource(null);
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] });
      queryClient.invalidateQueries({ queryKey: ['merge-conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['identity-stats'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success(dryRun ? '[Dry Run] Sync completo' : 'Todas las fuentes sincronizadas');
    },
    onError: (error: any) => {
      setSyncingSource(null);
      toast.error(`Error en sync: ${error.message}`);
    }
  });

  // Resolve conflict mutation
  const resolveConflict = useMutation({
    mutationFn: async ({ conflictId, resolution, clientId }: { conflictId: string, resolution: string, clientId?: string }) => {
      const { error } = await supabase
        .from('merge_conflicts')
        .update({
          status: 'resolved',
          resolution,
          resolved_at: new Date().toISOString(),
          suggested_client_id: clientId
        })
        .eq('id', conflictId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['merge-conflicts'] });
      toast.success('Conflicto resuelto');
    }
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-500/20 text-green-400"><CheckCircle className="w-3 h-3 mr-1" /> Completado</Badge>;
      case 'running':
        return <Badge className="bg-blue-500/20 text-blue-400"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> En progreso</Badge>;
      case 'failed':
        return <Badge className="bg-red-500/20 text-red-400"><XCircle className="w-3 h-3 mr-1" /> Error</Badge>;
      case 'partial':
        return <Badge className="bg-yellow-500/20 text-yellow-400"><AlertTriangle className="w-3 h-3 mr-1" /> Parcial</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getSourceIcon = (source: string) => {
    const Icon = SOURCE_ICONS[source] || Database;
    return <Icon className="w-4 h-4" />;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Unified Customer Sync</h1>
        <p className="text-muted-foreground">
          Sincroniza y unifica datos de todas las fuentes sin duplicados
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-6">
        {Object.entries(SOURCE_LABELS).map(([source, label]) => (
          <Card key={source} className="bg-card/50">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                {getSourceIcon(source)}
                <span className="text-sm font-medium">{label}</span>
              </div>
              <p className="text-2xl font-bold">
                {identityStats?.[source] || 0}
              </p>
              <p className="text-xs text-muted-foreground">identidades</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Sync Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Sync Orchestrator
          </CardTitle>
          <CardDescription>
            Ejecuta sincronización con staging, merge engine e identity map
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2">
              <Switch
                id="dry-run"
                checked={dryRun}
                onCheckedChange={setDryRun}
              />
              <Label htmlFor="dry-run" className="font-medium">
                Dry Run (Preview)
              </Label>
            </div>
            <span className="text-sm text-muted-foreground">
              {dryRun ? "Solo preview, no modifica datos" : "⚠️ Modificará la base de datos"}
            </span>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => syncGHL.mutate()}
              disabled={!!syncingSource}
              className="gap-2"
            >
              {syncingSource === 'ghl' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              Sync GoHighLevel
            </Button>

            <Button
              onClick={() => syncManyChat.mutate()}
              disabled={!!syncingSource}
              className="gap-2"
              variant="secondary"
            >
              {syncingSource === 'manychat' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <MessageSquare className="w-4 h-4" />
              )}
              Sync ManyChat
            </Button>

            <Button
              onClick={() => syncAll.mutate()}
              disabled={!!syncingSource}
              className="gap-2"
              variant="outline"
            >
              {syncingSource === 'all' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Sync All
            </Button>
          </div>

          {/* Field Mapping Documentation */}
          <div className="p-4 rounded-lg border border-border/50 bg-muted/30">
            <h4 className="font-medium mb-2">📋 Mapeo de Campos por Fuente</h4>
            <div className="grid gap-2 text-sm">
              <div className="flex gap-2">
                <Badge variant="outline">GHL</Badge>
                <span>email, phone/phoneNumber, firstName+lastName, tags, dndSettings.whatsApp/sms/email</span>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline">ManyChat</Badge>
                <span>email, phone/whatsapp_phone, first_name+last_name, tags[].name, optin_whatsapp/sms/email</span>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline">Prioridades</Badge>
                <span>Phone: Web &gt; GHL/ManyChat | Name: GHL/ManyChat &gt; Web | Status: Stripe &gt; todos | Tags: merge (union)</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Runs, Conflicts, Identities */}
      <Tabs defaultValue="runs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="runs" className="gap-2">
            <Clock className="w-4 h-4" />
            Sync Runs ({syncRuns.length})
          </TabsTrigger>
          <TabsTrigger value="conflicts" className="gap-2">
            <AlertTriangle className="w-4 h-4" />
            Conflictos ({conflicts.length})
          </TabsTrigger>
        </TabsList>

        {/* Sync Runs Tab */}
        <TabsContent value="runs">
          <Card>
            <CardHeader>
              <CardTitle>Historial de Sincronizaciones</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingRuns ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : syncRuns.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No hay sincronizaciones registradas
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fuente</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead className="text-right">Fetched</TableHead>
                      <TableHead className="text-right">Insertados</TableHead>
                      <TableHead className="text-right">Actualizados</TableHead>
                      <TableHead className="text-right">Conflictos</TableHead>
                      <TableHead>Modo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {syncRuns.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {getSourceIcon(run.source)}
                            <span className="font-medium">{SOURCE_LABELS[run.source] || run.source}</span>
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(run.status)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(run.started_at), 'dd/MM HH:mm')}
                        </TableCell>
                        <TableCell className="text-right">{run.total_fetched}</TableCell>
                        <TableCell className="text-right text-green-400">+{run.total_inserted}</TableCell>
                        <TableCell className="text-right text-blue-400">{run.total_updated}</TableCell>
                        <TableCell className="text-right text-yellow-400">{run.total_conflicts}</TableCell>
                        <TableCell>
                          {run.dry_run ? (
                            <Badge variant="outline"><Eye className="w-3 h-3 mr-1" /> Preview</Badge>
                          ) : (
                            <Badge className="bg-green-500/20 text-green-400">Live</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Conflicts Tab */}
        <TabsContent value="conflicts">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-400" />
                Conflictos Pendientes de Revisión
              </CardTitle>
              <CardDescription>
                Contactos que solo tienen teléfono o tienen datos inconsistentes
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingConflicts ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : conflicts.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle className="w-12 h-12 mx-auto text-green-400 mb-2" />
                  <p className="text-muted-foreground">No hay conflictos pendientes</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fuente</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Teléfono</TableHead>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {conflicts.map((conflict) => (
                      <TableRow key={conflict.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {getSourceIcon(conflict.source)}
                            <span>{SOURCE_LABELS[conflict.source] || conflict.source}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-yellow-400">
                            {conflict.conflict_type === 'phone_only' ? 'Solo teléfono' : conflict.conflict_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {conflict.email_found || '-'}
                        </TableCell>
                        <TableCell>{conflict.phone_found || '-'}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(conflict.created_at), 'dd/MM HH:mm')}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveConflict.mutate({ 
                                conflictId: conflict.id, 
                                resolution: 'create_new' 
                              })}
                            >
                              Crear nuevo
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => resolveConflict.mutate({ 
                                conflictId: conflict.id, 
                                resolution: 'ignored' 
                              })}
                            >
                              Ignorar
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
