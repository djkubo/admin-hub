import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export type SyncStep = 'paypal' | 'ghl' | 'manychat' | 'unify' | 'cleanup';

export interface SyncQueueStep {
  id: SyncStep;
  label: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  processed?: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface SyncQueueState {
  isRunning: boolean;
  currentStep: SyncStep | null;
  steps: SyncQueueStep[];
  overallProgress: number;
  startedAt: Date | null;
  estimatedTotalTime: number; // minutes
}

const INITIAL_STEPS: SyncQueueStep[] = [
  { id: 'paypal', label: 'PayPal', description: 'Últimos 7 días de transacciones', status: 'pending' },
  { id: 'ghl', label: 'GoHighLevel', description: 'Todo el historial de contactos', status: 'pending' },
  { id: 'manychat', label: 'ManyChat', description: 'Todos los suscriptores', status: 'pending' },
  { id: 'unify', label: 'Unificar', description: 'Fusionar todas las identidades', status: 'pending' },
  { id: 'cleanup', label: 'Limpieza', description: 'Eliminar datos antiguos', status: 'pending' },
];

export function useSyncQueue() {
  const [state, setState] = useState<SyncQueueState>({
    isRunning: false,
    currentStep: null,
    steps: INITIAL_STEPS.map(s => ({ ...s })),
    overallProgress: 0,
    startedAt: null,
    estimatedTotalTime: 45,
  });
  
  const abortRef = useRef(false);

  const updateStep = useCallback((stepId: SyncStep, updates: Partial<SyncQueueStep>) => {
    setState(prev => ({
      ...prev,
      steps: prev.steps.map(s => s.id === stepId ? { ...s, ...updates } : s),
    }));
  }, []);

  const calculateProgress = useCallback((steps: SyncQueueStep[]): number => {
    const weights = { paypal: 10, ghl: 25, manychat: 15, unify: 40, cleanup: 10 };
    let completed = 0;
    steps.forEach(step => {
      if (step.status === 'completed' || step.status === 'skipped') {
        completed += weights[step.id];
      } else if (step.status === 'running') {
        completed += weights[step.id] * 0.5; // Assume 50% when running
      }
    });
    return completed;
  }, []);

  // Execute PayPal sync (7 days)
  const executePayPal = async (): Promise<{ success: boolean; processed: number }> => {
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase.functions.invoke('fetch-paypal', {
      body: { startDate, endDate, mode: 'full' }
    });
    
    if (error) throw error;
    return { success: true, processed: data?.synced || 0 };
  };

  // Execute GHL sync (full history with pagination)
  const executeGHL = async (): Promise<{ success: boolean; processed: number }> => {
    let hasMore = true;
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let syncRunId: string | null = null;
    let totalProcessed = 0;

    while (hasMore && !abortRef.current) {
      const { data, error } = await supabase.functions.invoke('sync-ghl', {
        body: { stageOnly: true, startAfterId, startAfter, syncRunId }
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'GHL sync failed');

      totalProcessed += data.processed || 0;
      syncRunId = data.syncRunId;
      hasMore = data.hasMore === true;
      startAfterId = data.nextStartAfterId;
      startAfter = data.nextStartAfter;

      updateStep('ghl', { processed: totalProcessed });

      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    return { success: true, processed: totalProcessed };
  };

  // Execute ManyChat sync
  const executeManyChat = async (): Promise<{ success: boolean; processed: number }> => {
    let hasMore = true;
    let cursor = 0;
    let syncRunId: string | null = null;
    let totalProcessed = 0;

    while (hasMore && !abortRef.current) {
      const { data, error } = await supabase.functions.invoke('sync-manychat', {
        body: { stageOnly: true, cursor, syncRunId }
      });

      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'ManyChat sync failed');

      totalProcessed += data.staged || data.processed || 0;
      syncRunId = data.syncRunId;
      hasMore = data.hasMore === true;
      cursor = parseInt(data.nextCursor || '0', 10);

      updateStep('manychat', { processed: totalProcessed });

      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return { success: true, processed: totalProcessed };
  };

  // Execute Unify All
  const executeUnify = async (): Promise<{ success: boolean; processed: number }> => {
    const { data, error } = await supabase.functions.invoke('bulk-unify-contacts', {
      body: { sources: ['ghl', 'manychat', 'csv'], batchSize: 2000 }
    });

    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Unify failed');

    // Poll for completion
    const syncRunId = data.syncRunId;
    if (!syncRunId) return { success: true, processed: 0 };

    let completed = false;
    let totalProcessed = 0;

    while (!completed && !abortRef.current) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const { data: syncRun } = await supabase
        .from('sync_runs')
        .select('status, total_fetched, total_inserted')
        .eq('id', syncRunId)
        .single();

      if (!syncRun) break;

      totalProcessed = syncRun.total_fetched || 0;
      updateStep('unify', { processed: totalProcessed });

      if (['completed', 'failed', 'cancelled'].includes(syncRun.status)) {
        completed = true;
        if (syncRun.status !== 'completed') {
          throw new Error(`Unify ${syncRun.status}`);
        }
      }
    }

    return { success: true, processed: totalProcessed };
  };

  // Execute Cleanup
  const executeCleanup = async (): Promise<{ success: boolean; processed: number }> => {
    const { error } = await supabase.rpc('cleanup_old_data');
    if (error) throw error;
    return { success: true, processed: 0 };
  };

  // Main execution function
  const startFullRecovery = useCallback(async () => {
    if (state.isRunning) return;

    abortRef.current = false;
    setState(prev => ({
      ...prev,
      isRunning: true,
      currentStep: 'paypal',
      startedAt: new Date(),
      steps: INITIAL_STEPS.map(s => ({ ...s, status: 'pending' as const })),
      overallProgress: 0,
    }));

    toast.info('🚀 Iniciando Recuperación Completa...', { duration: 5000 });

    const executors: Record<SyncStep, () => Promise<{ success: boolean; processed: number }>> = {
      paypal: executePayPal,
      ghl: executeGHL,
      manychat: executeManyChat,
      unify: executeUnify,
      cleanup: executeCleanup,
    };

    for (const step of INITIAL_STEPS) {
      if (abortRef.current) {
        toast.warning('Recuperación cancelada');
        break;
      }

      setState(prev => ({ ...prev, currentStep: step.id }));
      updateStep(step.id, { status: 'running', startedAt: new Date() });

      try {
        const result = await executors[step.id]();
        updateStep(step.id, { 
          status: 'completed', 
          processed: result.processed,
          completedAt: new Date()
        });
        toast.success(`✅ ${step.label}: ${result.processed.toLocaleString()} registros`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        updateStep(step.id, { status: 'error', error: errorMessage });
        toast.error(`❌ ${step.label}: ${errorMessage}`);
        
        // Continue with next step despite errors
        console.error(`Error in ${step.id}:`, error);
      }

      // Update overall progress
      setState(prev => {
        const progress = calculateProgress(prev.steps);
        return { ...prev, overallProgress: progress };
      });

      // Small delay between steps
      if (!abortRef.current) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    setState(prev => ({
      ...prev,
      isRunning: false,
      currentStep: null,
      overallProgress: 100,
    }));

    if (!abortRef.current) {
      toast.success('🎉 Recuperación Completa finalizada', { duration: 8000 });
    }
  }, [state.isRunning, updateStep, calculateProgress]);

  const cancelRecovery = useCallback(() => {
    abortRef.current = true;
    setState(prev => ({
      ...prev,
      isRunning: false,
      currentStep: null,
    }));
  }, []);

  const resetQueue = useCallback(() => {
    setState({
      isRunning: false,
      currentStep: null,
      steps: INITIAL_STEPS.map(s => ({ ...s })),
      overallProgress: 0,
      startedAt: null,
      estimatedTotalTime: 45,
    });
  }, []);

  return {
    ...state,
    startFullRecovery,
    cancelRecovery,
    resetQueue,
  };
}
