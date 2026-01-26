import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, CheckCircle, Clock, AlertCircle, Users, FileText } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface ImportRun {
  id: string;
  filename: string | null;
  source_type: string;
  total_rows: number;
  rows_staged: number;
  rows_merged: number;
  rows_conflict: number;
  rows_error: number;
  status: string;
  started_at: string;
  staged_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface StagedContact {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  source_type: string;
  processing_status: string;
  created_at: string;
  import_id: string;
}

export function StagingContactsPanel() {
  const queryClient = useQueryClient();
  const [selectedImport, setSelectedImport] = useState<string | null>(null);

  // Fetch recent import runs
  const { data: importRuns = [], isLoading: runsLoading, refetch: refetchRuns } = useQuery({
    queryKey: ['csv-import-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('csv_import_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10);
      
      if (error) throw error;
      return data as ImportRun[];
    },
    refetchInterval: 5000 // Auto-refresh every 5s
  });

  // Fetch staged contacts for selected import
  const { data: stagedContacts = [], isLoading: contactsLoading } = useQuery({
    queryKey: ['staged-contacts', selectedImport],
    queryFn: async () => {
      if (!selectedImport) return [];
      
      const { data, error } = await supabase
        .from('csv_imports_raw')
        .select('id, email, phone, full_name, source_type, processing_status, created_at, import_id')
        .eq('import_id', selectedImport)
        .order('row_number', { ascending: true })
        .limit(100);
      
      if (error) throw error;
      return data as StagedContact[];
    },
    enabled: !!selectedImport
  });

  // Count pending imports
  const pendingRuns = importRuns.filter(r => r.status === 'staging' || r.status === 'processing');
  const completedRuns = importRuns.filter(r => r.status === 'completed');

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'staging':
        return <Badge variant="secondary"><Clock className="h-3 w-3 mr-1" /> Staging</Badge>;
      case 'processing':
        return <Badge variant="default" className="bg-blue-500"><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Procesando</Badge>;
      case 'completed':
        return <Badge variant="default" className="bg-green-500"><CheckCircle className="h-3 w-3 mr-1" /> Completo</Badge>;
      case 'staged':
        return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" /> En cola</Badge>;
      case 'failed':
        return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" /> Error</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getContactStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="text-yellow-600">Pendiente</Badge>;
      case 'merged':
        return <Badge variant="default" className="bg-green-500">Unificado</Badge>;
      case 'conflict':
        return <Badge variant="destructive">Conflicto</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      case 'skipped':
        return <Badge variant="secondary">Omitido</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const handleRefresh = () => {
    refetchRuns();
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    queryClient.invalidateQueries({ queryKey: ['clients-count'] });
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Importaciones Activas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <RefreshCw className={`h-5 w-5 text-blue-500 ${pendingRuns.length > 0 ? 'animate-spin' : ''}`} />
              <span className="text-2xl font-bold">{pendingRuns.length}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completadas (Hoy)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-2xl font-bold">{completedRuns.length}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Filas Procesadas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              <span className="text-2xl font-bold">
                {importRuns.reduce((acc, r) => acc + (r.rows_merged || 0), 0).toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Import Runs Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Importaciones Recientes
            </CardTitle>
            <CardDescription>
              Los contactos aparecen inmediatamente. La unificación se procesa en segundo plano.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Actualizar
          </Button>
        </CardHeader>
        <CardContent>
          {runsLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : importRuns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No hay importaciones recientes
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Archivo</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Progreso</TableHead>
                  <TableHead>Tiempo</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {importRuns.map(run => {
                  const progress = run.total_rows > 0 
                    ? Math.round(((run.rows_merged + run.rows_error + run.rows_conflict) / run.total_rows) * 100)
                    : 0;
                  
                  return (
                    <TableRow 
                      key={run.id} 
                      className={selectedImport === run.id ? 'bg-muted/50' : ''}
                    >
                      <TableCell className="font-medium">
                        {run.filename || 'Sin nombre'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{run.source_type}</Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(run.status)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-[150px]">
                          <Progress value={progress} className="h-2 flex-1" />
                          <span className="text-xs text-muted-foreground w-12">
                            {run.rows_merged}/{run.total_rows}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDistanceToNow(new Date(run.started_at), { 
                          addSuffix: true, 
                          locale: es 
                        })}
                      </TableCell>
                      <TableCell>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => setSelectedImport(run.id === selectedImport ? null : run.id)}
                        >
                          {selectedImport === run.id ? 'Ocultar' : 'Ver'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Staged Contacts Detail */}
      {selectedImport && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Contactos de la Importación</CardTitle>
            <CardDescription>
              Mostrando primeros 100 contactos
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contactsLoading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : stagedContacts.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No hay contactos para mostrar
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Teléfono</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stagedContacts.map(contact => (
                    <TableRow key={contact.id}>
                      <TableCell className="font-medium">
                        {contact.email || '-'}
                      </TableCell>
                      <TableCell>{contact.full_name || '-'}</TableCell>
                      <TableCell>{contact.phone || '-'}</TableCell>
                      <TableCell>{getContactStatusBadge(contact.processing_status)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
