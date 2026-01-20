import { useState } from 'react';
import { Upload, RefreshCw, CheckCircle, AlertCircle, Loader2, History, FileText, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CSVUploader } from './CSVUploader';
import { APISyncPanel } from './APISyncPanel';
import { SmartRecoveryCard } from './SmartRecoveryCard';
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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Upload className="h-8 w-8 text-cyan-500" />
          Importar / Sincronizar
        </h1>
        <p className="text-muted-foreground mt-1">
          Importa datos por CSV o sincroniza directamente desde APIs
        </p>
      </div>

      <Tabs defaultValue="api" className="space-y-6">
        <TabsList className="bg-card border border-border/50">
          <TabsTrigger value="api" className="gap-2 data-[state=active]:bg-primary/20">
            <Database className="h-4 w-4" />
            API Sync
          </TabsTrigger>
          <TabsTrigger value="csv" className="gap-2 data-[state=active]:bg-primary/20">
            <FileText className="h-4 w-4" />
            CSV Import
          </TabsTrigger>
          <TabsTrigger value="recovery" className="gap-2 data-[state=active]:bg-primary/20">
            <RefreshCw className="h-4 w-4" />
            Smart Recovery
          </TabsTrigger>
        </TabsList>

        <TabsContent value="api">
          <APISyncPanel />
        </TabsContent>

        <TabsContent value="csv">
          <CSVUploader onProcessingComplete={handleProcessingComplete} />
        </TabsContent>

        <TabsContent value="recovery">
          <SmartRecoveryCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
