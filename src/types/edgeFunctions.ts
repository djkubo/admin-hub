/**
 * Type definitions for Edge Function requests and responses.
 * Used to ensure type safety when invoking backend functions.
 */

// ============= SYNC COMMAND CENTER =============

export interface SyncCommandCenterBody {
  mode?: 'today' | '7d' | 'month' | 'full';
  startDate?: string;
  endDate?: string;
  includeContacts?: boolean;
}

export interface SyncStepResult {
  success: boolean;
  count: number;
  error?: string;
}

export interface SyncCommandCenterResponse {
  success: boolean;
  syncRunId?: string;
  mode?: string;
  totalRecords?: number;
  results?: Record<string, SyncStepResult>;
  failedSteps?: string[];
  error?: string;
}

// ============= STRIPE =============

export interface FetchStripeBody {
  fetchAll?: boolean;
  startDate?: string;
  endDate?: string;
  cursor?: string | null;
  syncRunId?: string | null;
  [key: string]: unknown;
}

export interface FetchStripeResponse {
  success: boolean;
  synced_transactions?: number;
  paid_count?: number;
  failed_count?: number;
  syncRunId?: string;
  nextCursor?: string | null;
  hasMore?: boolean;
  error?: string;
}

// ============= PAYPAL =============

export interface FetchPayPalBody {
  fetchAll?: boolean;
  startDate?: string;
  endDate?: string;
  page?: number;
  syncRunId?: string | null;
  [key: string]: unknown;
}

export interface FetchPayPalResponse {
  success: boolean;
  synced_transactions?: number;
  paid_count?: number;
  failed_count?: number;
  syncRunId?: string;
  nextPage?: number;
  hasMore?: boolean;
  error?: string;
}

// ============= SUBSCRIPTIONS =============

export interface FetchSubscriptionsBody {
  limit?: number;
}

export interface FetchSubscriptionsResponse {
  success: boolean;
  synced?: number;
  upserted?: number;
  error?: string;
}

// ============= INVOICES =============

export interface FetchInvoicesBody {
  limit?: number;
  status?: string;
}

export interface FetchInvoicesResponse {
  success: boolean;
  synced?: number;
  error?: string;
}

// ============= GENERIC SYNC RESPONSES =============

export interface GenericSyncResponse {
  success: boolean;
  synced?: number;
  upserted?: number;
  unified?: number;
  error?: string;
  message?: string;
}

// ============= MANYCHAT / GHL =============

export interface SyncContactsBody {
  dry_run?: boolean;
  batch_size?: number;
  background?: boolean;
  [key: string]: unknown;
}

export interface SyncContactsResponse {
  success: boolean;
  mode?: string;
  sync_run_id?: string;
  stats?: {
    total_fetched?: number;
    total_inserted?: number;
    total_updated?: number;
    total_conflicts?: number;
  };
  message?: string;
  error?: string;
}

// ============= SYNC RESULT (for UI) =============

export interface SyncResult {
  success: boolean;
  synced_transactions?: number;
  synced_clients?: number;
  paid_count?: number;
  failed_count?: number;
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_conflicts?: number;
  message?: string;
  error?: string;
}
