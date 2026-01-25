import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { invokeWithAdminKey } from "@/lib/adminApi";

export interface Invoice {
  id: string;
  stripe_invoice_id: string;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  stripe_customer_id: string | null;
  client_id: string | null;
  amount_due: number;
  amount_paid: number | null;
  amount_remaining: number | null;
  subtotal: number | null;
  total: number | null;
  currency: string;
  status: string;
  stripe_created_at: string | null;
  finalized_at: string | null;
  automatically_finalizes_at: string | null;
  period_end: string | null;
  next_payment_attempt: string | null;
  due_date: string | null;
  hosted_invoice_url: string | null;
  pdf_url: string | null;
  invoice_number: string | null;
  subscription_id: string | null;
  plan_name: string | null;
  plan_interval: string | null;
  product_name: string | null;
  attempt_count: number | null;
  billing_reason: string | null;
  collection_method: string | null;
  description: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  default_payment_method: string | null;
  last_finalization_error: string | null;
  lines: Array<{
    id: string;
    amount: number;
    currency: string;
    description: string | null;
    quantity: number;
    price_id?: string;
    price_nickname?: string;
    unit_amount?: number;
    interval?: string;
    product_name?: string;
  }> | null;
  raw_data?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type InvoiceStatus = 'all' | 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

interface FetchInvoicesResponse {
  success: boolean;
  synced: number;
  upserted: number;
  hasMore: boolean;
  nextCursor: string | null;
  syncRunId: string | null;
  error?: string;
  stats?: {
    draft: number;
    open: number;
    paid: number;
    void: number;
    uncollectible: number;
  };
}

interface UseInvoicesOptions {
  statusFilter?: InvoiceStatus;
  searchQuery?: string;
  startDate?: string;
  endDate?: string;
}

export function useInvoices(options: UseInvoicesOptions = {}) {
  const { statusFilter = 'all', searchQuery = '', startDate, endDate } = options;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncProgress, setSyncProgress] = useState<{ current: number; hasMore: boolean } | null>(null);

  // Fetch invoices with filters
  const { data: invoices = [], isLoading, refetch } = useQuery({
    queryKey: ["invoices", statusFilter, searchQuery, startDate, endDate],
    queryFn: async () => {
      let query = supabase
        .from("invoices")
        .select("*")
        .order("stripe_created_at", { ascending: false, nullsFirst: false });

      // Status filter
      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      // Date range filter using stripe_created_at
      if (startDate) {
        query = query.gte('stripe_created_at', startDate);
      }
      if (endDate) {
        query = query.lte('stripe_created_at', endDate);
      }

      // Search filter
      if (searchQuery) {
        query = query.or(`customer_email.ilike.%${searchQuery}%,customer_name.ilike.%${searchQuery}%,invoice_number.ilike.%${searchQuery}%`);
      }

      const { data, error } = await query;

      if (error) throw error;
      
      return (data || []).map(row => ({
        ...row,
        lines: row.lines as unknown as Invoice['lines'],
        raw_data: row.raw_data as unknown as Invoice['raw_data'],
      })) as Invoice[];
    },
  });

  // Realtime subscription for invoices table
  useEffect(() => {
    const channel = supabase.channel('invoices-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => {
        refetch();
      })
      .subscribe();
      
    return () => { supabase.removeChannel(channel); };
  }, [refetch]);

  // Full sync with pagination
  const syncInvoicesFull = useCallback(async (mode: 'full' | 'recent' = 'recent') => {
    setSyncProgress({ current: 0, hasMore: true });
    let cursor: string | null = null;
    let totalSynced = 0;
    let syncRunId: string | null = null;

    try {
      while (true) {
        const result = await invokeWithAdminKey<FetchInvoicesResponse>("fetch-invoices", {
          mode,
          cursor,
          syncRunId,
        });

        if (!result.success) {
          throw new Error(result.error || 'Sync failed');
        }

        totalSynced += result.upserted;
        syncRunId = result.syncRunId;
        setSyncProgress({ current: totalSynced, hasMore: result.hasMore });

        if (!result.hasMore || !result.nextCursor) {
          break;
        }

        cursor = result.nextCursor;
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 200));
      }

      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      toast({
        title: "Sincronización completa",
        description: `${totalSynced} facturas sincronizadas`,
      });

      return { success: true, synced: totalSynced };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast({
        title: "Error al sincronizar",
        description: message,
        variant: "destructive",
      });
      return { success: false, error: message };
    } finally {
      setSyncProgress(null);
    }
  }, [queryClient, toast]);

  // Quick sync mutation (recent only)
  const syncInvoices = useMutation({
    mutationFn: async () => {
      return await invokeWithAdminKey<FetchInvoicesResponse>("fetch-invoices", { mode: 'recent' });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      toast({
        title: "Facturas sincronizadas",
        description: `${data.upserted || 0} facturas actualizadas`,
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      toast({
        title: "Error al sincronizar facturas",
        description: message,
        variant: "destructive",
      });
    },
  });

  // Calculate totals
  const totalPending = invoices
    .filter(inv => inv.status === 'open' || inv.status === 'draft')
    .reduce((sum, inv) => sum + inv.amount_due, 0) / 100;

  const totalPaid = invoices
    .filter(inv => inv.status === 'paid')
    .reduce((sum, inv) => sum + (inv.amount_paid || 0), 0) / 100;

  // Get invoices due in next 72 hours
  const next72Hours = new Date();
  next72Hours.setHours(next72Hours.getHours() + 72);

  const invoicesNext72h = invoices.filter((inv) => {
    if (!inv.next_payment_attempt || inv.status !== 'open') return false;
    const attemptDate = new Date(inv.next_payment_attempt);
    return attemptDate <= next72Hours;
  });

  const totalNext72h = invoicesNext72h.reduce((sum, inv) => sum + inv.amount_due, 0) / 100;

  // Status counts
  const statusCounts = {
    all: invoices.length,
    draft: invoices.filter(i => i.status === 'draft').length,
    open: invoices.filter(i => i.status === 'open').length,
    paid: invoices.filter(i => i.status === 'paid').length,
    void: invoices.filter(i => i.status === 'void').length,
    uncollectible: invoices.filter(i => i.status === 'uncollectible').length,
  };

  // Export to CSV
  const exportToCSV = useCallback(() => {
    if (invoices.length === 0) {
      toast({ title: "Sin datos para exportar", variant: "destructive" });
      return;
    }

    const headers = [
      'Invoice Number', 'Customer Name', 'Customer Email', 'Amount Due', 'Amount Paid',
      'Currency', 'Status', 'Plan', 'Frequency', 'Due Date', 'Created At', 'PDF URL'
    ];

    const rows = invoices.map(inv => [
      inv.invoice_number || inv.stripe_invoice_id,
      inv.customer_name || '',
      inv.customer_email || '',
      (inv.amount_due / 100).toFixed(2),
      ((inv.amount_paid || 0) / 100).toFixed(2),
      inv.currency?.toUpperCase() || 'USD',
      inv.status,
      inv.product_name || inv.plan_name || '',
      inv.plan_interval || '',
      inv.due_date || '',
      inv.stripe_created_at || '',
      inv.pdf_url || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `invoices_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();

    toast({ title: "CSV exportado", description: `${invoices.length} facturas exportadas` });
  }, [invoices, toast]);

  return {
    invoices,
    isLoading,
    refetch,
    syncInvoices,
    syncInvoicesFull,
    syncProgress,
    totalPending,
    totalPaid,
    totalNext72h,
    invoicesNext72h,
    statusCounts,
    exportToCSV,
  };
}
