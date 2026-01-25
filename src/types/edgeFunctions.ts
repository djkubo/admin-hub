/**
 * Type definitions for Edge Function requests and responses.
 * Provides strict typing for all backend API interactions.
 * 
 * SYNC CONTRACT: All sync functions return a consistent structure:
 * - success: boolean
 * - status: 'running' | 'continuing' | 'completed' | 'failed'
 * - syncRunId: string
 * - hasMore: boolean (for pagination)
 * - duration_ms: number
 * - error/error_message: string (on failure)
 */

// ============= BASE SYNC CONTRACT =============

export type SyncStatus = 'running' | 'continuing' | 'completed' | 'completed_with_errors' | 'failed';

export interface BaseSyncResponse {
  success: boolean;
  status?: SyncStatus;
  syncRunId?: string;
  hasMore?: boolean;
  nextCursor?: string | null;
  stats?: Record<string, unknown> | null;
  duration_ms?: number;
  error?: string;
  error_message?: string;
}

// ============= SYNC COMMAND CENTER =============

export interface SyncCommandCenterBody {
  startDate?: string;
  endDate?: string;
  fetchAll?: boolean;
  cursor?: string | null;
  limit?: number;
  includeContacts?: boolean;
}

export interface SyncStepResult {
  success: boolean;
  count: number;
  error?: string;
}

export interface SyncCommandCenterResponse extends BaseSyncResponse {
  totalRecords?: number;
  results?: Record<string, SyncStepResult>;
  failedSteps?: string[];
}

// ============= STRIPE =============

export interface FetchStripeBody {
  fetchAll?: boolean;
  startDate?: string;
  endDate?: string;
  cursor?: string | null;
  limit?: number;
  syncRunId?: string | null;
  previousTotal?: number;
  cleanupStale?: boolean;
  [key: string]: unknown;
}

export interface FetchStripeResponse extends BaseSyncResponse {
  synced_transactions?: number;
  synced_clients?: number;
  paid_count?: number;
  failed_count?: number;
  skipped?: number;
  total_so_far?: number;
  previousTotal?: number;
  // Cleanup response
  cleaned?: number;
  message?: string;
}

// ============= PAYPAL =============

export interface FetchPayPalBody {
  fetchAll?: boolean;
  startDate?: string;
  endDate?: string;
  cursor?: string | null;
  limit?: number;
  syncRunId?: string | null;
  cleanupStale?: boolean;
  [key: string]: unknown;
}

export interface FetchPayPalResponse extends BaseSyncResponse {
  synced_transactions?: number;
  synced_clients?: number;
  paid_count?: number;
  failed_count?: number;
  currentPage?: number;
  totalPages?: number;
  // Cleanup response
  cleaned?: number;
  existingSyncId?: string;
  message?: string;
}

// ============= SUBSCRIPTIONS =============

export interface FetchSubscriptionsBody {
  limit?: number;
  cursor?: string | null;
  syncRunId?: string | null;
}

export interface FetchSubscriptionsResponse extends BaseSyncResponse {
  synced?: number;
  upserted?: number;
  total_fetched?: number;
  total_inserted?: number;
}

// ============= INVOICES =============

export interface FetchInvoicesBody {
  startDate?: string;
  endDate?: string;
  fetchAll?: boolean;
  cursor?: string | null;
  limit?: number;
  syncRunId?: string | null;
  [key: string]: unknown;
}

export interface FetchInvoicesResponse extends BaseSyncResponse {
  synced?: number;
  upserted?: number;
  draftCount?: number;
  openCount?: number;
  excludedCount?: number;
  totalPending?: number;
  total_fetched?: number;
  total_inserted?: number;
  stats?: {
    draft: number;
    open: number;
    paid: number;
    void: number;
    uncollectible: number;
  };
}

// ============= CUSTOMERS =============

export interface FetchCustomersBody {
  limit?: number;
  starting_after?: string;
  fetchAll?: boolean;
}

export interface FetchCustomersResponse extends BaseSyncResponse {
  synced?: number;
  total_fetched?: number;
  total_inserted?: number;
}

// ============= PRODUCTS & PRICES =============

export interface FetchProductsBody {
  includeInactive?: boolean;
}

export interface FetchProductsResponse extends BaseSyncResponse {
  synced?: number;
  products_count?: number;
  prices_count?: number;
  total_fetched?: number;
}

// ============= DISPUTES =============

export interface FetchDisputesBody {
  startDate?: string;
  endDate?: string;
}

export interface FetchDisputesResponse extends BaseSyncResponse {
  synced?: number;
  total_fetched?: number;
  total_inserted?: number;
}

// ============= PAYOUTS =============

export interface FetchPayoutsBody {
  startDate?: string;
  endDate?: string;
}

export interface FetchPayoutsResponse extends BaseSyncResponse {
  synced?: number;
  total_fetched?: number;
  total_inserted?: number;
}

// ============= BALANCE =============

export interface FetchBalanceBody {
  snapshot?: boolean;
}

export interface BalanceAmount {
  currency: string;
  amount: number;
}

export interface FetchBalanceResponse extends BaseSyncResponse {
  stripe_available?: BalanceAmount[];
  stripe_pending?: BalanceAmount[];
  paypal_available?: BalanceAmount[];
  total_available_usd?: number;
  snapshot_id?: string;
}

// ============= PAYPAL SUBSCRIPTIONS =============

export interface FetchPayPalSubscriptionsBody {
  status?: string;
  syncRunId?: string | null;
}

export interface FetchPayPalSubscriptionsResponse extends BaseSyncResponse {
  synced?: number;
  total_fetched?: number;
  total_inserted?: number;
}

// ============= PAYPAL DISPUTES =============

export interface FetchPayPalDisputesBody {
  startDate?: string;
  endDate?: string;
}

export interface FetchPayPalDisputesResponse extends BaseSyncResponse {
  synced?: number;
  total_fetched?: number;
}

// ============= PAYPAL PRODUCTS =============

export interface FetchPayPalProductsBody {
  includeInactive?: boolean;
}

export interface FetchPayPalProductsResponse extends BaseSyncResponse {
  synced?: number;
  products_count?: number;
  plans_count?: number;
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

export interface ExecuteCampaignBody {
  campaign_id: string;
  test_mode?: boolean;
}

export interface ExecuteCampaignResponse {
  success: boolean;
  sent_count?: number;
  failed_count?: number;
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

export interface GenericSyncResponse extends BaseSyncResponse {
  synced?: number;
  upserted?: number;
  unified?: number;
  message?: string;
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_conflicts?: number;
}

// ============= MANYCHAT / GHL SYNC =============

export interface SyncContactsBody {
  dry_run?: boolean;
  batch_size?: number;
  background?: boolean;
  offset?: number;
  syncRunId?: string | null;
  [key: string]: unknown;
}

export interface SyncContactsStats {
  total_fetched?: number;
  total_inserted?: number;
  total_updated?: number;
  total_conflicts?: number;
  total_skipped?: number;
}

export interface SyncContactsResponse extends BaseSyncResponse {
  mode?: string;
  sync_run_id?: string;
  stats?: SyncContactsStats;
  message?: string;
  nextOffset?: number;
  contactsFetched?: number;
  inserted?: number;
  updated?: number;
}

// ============= SYNC RESULT (for UI state) =============

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

// ============= RECOVER REVENUE =============

export interface RecoverRevenueBody {
  client_id?: string;
  invoice_id?: string;
  channel?: 'sms' | 'whatsapp' | 'email';
}

export interface RecoverRevenueResponse {
  success: boolean;
  message_sent?: boolean;
  recovery_id?: string;
  error?: string;
}

// ============= SMS =============

export interface SendSMSBody {
  to: string;
  message: string;
  client_id?: string;
}

export interface SendSMSResponse {
  success: boolean;
  message_sid?: string;
  error?: string;
}

// ============= TEMPLATES =============

export interface GetTemplatesBody {
  channel?: 'sms' | 'whatsapp' | 'email';
}

export interface Template {
  id: string;
  name: string;
  content: string;
  channel: string;
}

export interface GetTemplatesResponse {
  success: boolean;
  templates?: Template[];
  error?: string;
}
