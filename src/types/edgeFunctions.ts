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
  draftCount?: number;
  openCount?: number;
  excludedCount?: number;
  totalPending?: number;
  error?: string;
}

// ============= FORCE CHARGE INVOICE =============

export interface ForceChargeInvoiceBody {
  invoice_id?: string;
  stripe_invoice_id?: string;
}

export interface ForceChargeInvoiceResponse {
  success: boolean;
  amount_paid?: number;
  message?: string;
  error?: string;
}

// ============= PORTAL SESSION =============

export interface CreatePortalSessionBody {
  stripe_customer_id?: string;
  email?: string;
  return_url?: string;
}

export interface CreatePortalSessionResponse {
  url?: string;
  error?: string;
}

// ============= CAMPAIGNS =============

export interface SendCampaignBody {
  campaign_id: string;
  dry_run?: boolean;
}

export interface SendCampaignStats {
  total?: number;
  excluded?: number;
  sent?: number;
  failed?: number;
}

export interface SendCampaignResponse {
  success: boolean;
  dry_run?: boolean;
  stats?: SendCampaignStats;
  error?: string;
}

// ============= RECONCILE =============

export interface ReconcileMetricsBody {
  source: string;
  start_date: string;
  end_date: string;
}

export interface ReconcileMetricsResponse {
  status: 'ok' | 'warning' | 'error';
  difference: number;
  difference_pct: number;
  external_total?: number;
  internal_total?: number;
  error?: string;
}

// ============= ANALYZE BUSINESS =============

export interface AnalyzeBusinessBody {
  prompt: string;
  context?: string;
}

export interface AnalyzeBusinessResponse {
  analysis?: string;
  message?: string;
  error?: string;
}

// ============= MANYCHAT SEND =============

export interface SendManyChatBody {
  email?: string;
  phone?: string;
  template: string;
  client_name?: string;
  amount?: number;
  client_id?: string;
  tag?: string;
}

export interface SendManyChatResponse {
  success?: boolean;
  message_id?: string;
  error?: string;
}

// ============= GHL NOTIFY =============

export interface NotifyGHLBody {
  email?: string;
  phone?: string;
  name?: string;
  tag?: string;
  message_data?: Record<string, unknown>;
}

export interface NotifyGHLResponse {
  success?: boolean;
  contact_id?: string;
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

// ============= MANYCHAT / GHL SYNC =============

export interface SyncContactsBody {
  dry_run?: boolean;
  batch_size?: number;
  background?: boolean;
  [key: string]: unknown;
}

export interface SyncContactsStats {
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_conflicts?: number;
}

export interface SyncContactsResponse {
  success: boolean;
  mode?: string;
  sync_run_id?: string;
  stats?: SyncContactsStats;
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
