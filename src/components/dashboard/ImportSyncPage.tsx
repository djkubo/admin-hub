import { useState } from 'react';
import { Upload, RefreshCw, CheckCircle, AlertCircle, Loader2, History, FileText, Database, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CSVUploader } from './CSVUploader';
import { APISyncPanel } from './APISyncPanel';
import { SmartRecoveryCard } from './SmartRecoveryCard';
import { SyncOrchestrator } from './SyncOrchestrator';
import { SyncResultsPanel } from './SyncResultsPanel';
import { useQueryClient } from '@tanstack/react-query';

export function ImportSyncPage() {
  const queryClient = useQueryClient();

  const handleProcessingComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['clients'] });
    queryClient.invalidateQueries({ queryKey: ['clients-count'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['metrics'] });
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-white flex items-center gap-2 sm:gap-3">
            <Upload className="h-6 w-6 sm:h-8 sm:w-8 text-cyan-500" />
            Importar / Sincronizar
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Importa datos por CSV o sincroniza desde APIs
          </p>
        </div>
      </div>

      {/* Sync Status Panel - Shows active and recent syncs */}
      <SyncResultsPanel />

      <Tabs defaultValue="api" className="space-y-4 sm:space-y-6">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="bg-card border border-border/50 w-max sm:w-auto">
            <TabsTrigger value="api" className="gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 data-[state=active]:bg-primary/20">
              <Database className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden xs:inline">API</span> Sync
            </TabsTrigger>
            <TabsTrigger value="csv" className="gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 data-[state=active]:bg-primary/20">
              <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              CSV
            </TabsTrigger>
            <TabsTrigger value="recovery" className="gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 data-[state=active]:bg-primary/20">
              <RefreshCw className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Recovery
            </TabsTrigger>
            <TabsTrigger value="unify" className="gap-1.5 sm:gap-2 text-xs sm:text-sm px-2.5 sm:px-3 data-[state=active]:bg-primary/20">
              <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              Unificar
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="api">
          <APISyncPanel />
        </TabsContent>

        <TabsContent value="csv">
          <CSVUploader onProcessingComplete={handleProcessingComplete} />
        </TabsContent>

        <TabsContent value="recovery">
          <SmartRecoveryCard />
        </TabsContent>

        <TabsContent value="unify">
          <SyncOrchestrator />
        </TabsContent>
      </Tabs>
    </div>
  );
}
