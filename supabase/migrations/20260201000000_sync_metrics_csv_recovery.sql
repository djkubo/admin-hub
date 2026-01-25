-- Add invoice customer snapshot + metadata
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS invoice_customer_snapshot JSONB,
ADD COLUMN IF NOT EXISTS invoice_metadata JSONB;

COMMENT ON COLUMN public.invoices.invoice_customer_snapshot IS 'Snapshot of Stripe customer details at invoice time';
COMMENT ON COLUMN public.invoices.invoice_metadata IS 'Stripe invoice metadata (key/value)';

-- Recovery attempts log
CREATE TABLE IF NOT EXISTS public.recovery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID REFERENCES public.invoices(id),
  stripe_invoice_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  idempotency_key TEXT,
  amount INTEGER,
  currency TEXT,
  attempted_by TEXT,
  sync_run_id UUID REFERENCES public.sync_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_invoice_id ON public.recovery_attempts(invoice_id);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_stripe_invoice_id ON public.recovery_attempts(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_idempotency_key ON public.recovery_attempts(idempotency_key);

ALTER TABLE public.recovery_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin can view recovery attempts" ON public.recovery_attempts
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert recovery attempts" ON public.recovery_attempts
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update recovery attempts" ON public.recovery_attempts
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Dashboard metrics RPC to avoid large client-side selects
CREATE OR REPLACE FUNCTION public.dashboard_metrics()
RETURNS TABLE(
  sales_today_usd bigint,
  sales_today_mxn bigint,
  sales_month_usd bigint,
  sales_month_mxn bigint,
  trial_count bigint,
  converted_count bigint,
  churn_count bigint,
  lead_count bigint,
  customer_count bigint,
  recovery_list jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text := 'America/Mexico_City';
  v_start_today timestamptz;
  v_start_month timestamptz;
BEGIN
  v_start_today := DATE_TRUNC('day', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
  v_start_month := DATE_TRUNC('month', NOW() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

  RETURN QUERY
  WITH tx AS (
    SELECT
      amount,
      currency,
      COALESCE(stripe_created_at, created_at) AS created_at,
      customer_email,
      source,
      failure_code,
      status
    FROM public.transactions
    WHERE status IN ('paid', 'succeeded', 'failed')
  ),
  sales_today AS (
    SELECT
      COALESCE(SUM(CASE WHEN lower(currency) = 'mxn' THEN amount ELSE 0 END), 0) AS mxn,
      COALESCE(SUM(CASE WHEN lower(currency) <> 'mxn' OR currency IS NULL THEN amount ELSE 0 END), 0) AS usd
    FROM tx
    WHERE status IN ('paid', 'succeeded')
      AND created_at >= v_start_today
  ),
  sales_month AS (
    SELECT
      COALESCE(SUM(CASE WHEN lower(currency) = 'mxn' THEN amount ELSE 0 END), 0) AS mxn,
      COALESCE(SUM(CASE WHEN lower(currency) <> 'mxn' OR currency IS NULL THEN amount ELSE 0 END), 0) AS usd
    FROM tx
    WHERE status IN ('paid', 'succeeded')
      AND created_at >= v_start_month
  ),
  lifecycle AS (
    SELECT
      COUNT(*) FILTER (WHERE lifecycle_stage = 'LEAD') AS lead_count,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'CUSTOMER') AS customer_count,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'CHURN') AS churn_count,
      COUNT(DISTINCT email) FILTER (WHERE trial_started_at IS NOT NULL) AS trial_count,
      COUNT(DISTINCT email) FILTER (WHERE converted_at IS NOT NULL) AS converted_count
    FROM public.clients
  ),
  failed AS (
    SELECT
      customer_email,
      SUM(amount) AS amount,
      COALESCE(MIN(source), 'unknown') AS source
    FROM tx
    WHERE status = 'failed'
      OR failure_code IN ('requires_payment_method', 'requires_action', 'requires_confirmation')
    GROUP BY customer_email
  ),
  failed_ranked AS (
    SELECT
      f.customer_email,
      f.amount,
      f.source,
      c.full_name,
      c.phone
    FROM failed f
    LEFT JOIN public.clients c ON c.email = f.customer_email
    WHERE f.customer_email IS NOT NULL
    ORDER BY f.amount DESC
    LIMIT 100
  )
  SELECT
    (SELECT usd FROM sales_today) AS sales_today_usd,
    (SELECT mxn FROM sales_today) AS sales_today_mxn,
    (SELECT usd FROM sales_month) AS sales_month_usd,
    (SELECT mxn FROM sales_month) AS sales_month_mxn,
    (SELECT trial_count FROM lifecycle),
    (SELECT converted_count FROM lifecycle),
    (SELECT churn_count FROM lifecycle),
    (SELECT lead_count FROM lifecycle),
    (SELECT customer_count FROM lifecycle),
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'email', customer_email,
      'full_name', full_name,
      'phone', phone,
      'amount', amount / 100.0,
      'source', source
    )) FROM failed_ranked), '[]'::jsonb) AS recovery_list;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_metrics() TO authenticated;

-- Source metrics RPC for analytics
CREATE OR REPLACE FUNCTION public.source_metrics(
  p_days integer DEFAULT 30
)
RETURNS TABLE(
  source text,
  leads bigint,
  trials bigint,
  customers bigint,
  revenue bigint,
  total_spend bigint,
  customer_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
BEGIN
  v_start := NOW() - (p_days || ' days')::interval;

  RETURN QUERY
  WITH client_counts AS (
    SELECT
      COALESCE(acquisition_source, 'unknown') AS source,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'LEAD') AS leads,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'TRIAL') AS trials,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'CUSTOMER') AS customers,
      COUNT(*) FILTER (WHERE lifecycle_stage = 'CUSTOMER') AS customer_count,
      COALESCE(SUM(total_spend) FILTER (WHERE lifecycle_stage = 'CUSTOMER'), 0) AS total_spend
    FROM public.clients
    GROUP BY COALESCE(acquisition_source, 'unknown')
  ),
  revenue_by_source AS (
    SELECT
      COALESCE(c.acquisition_source, 'unknown') AS source,
      COALESCE(SUM(t.amount), 0) AS revenue
    FROM public.transactions t
    LEFT JOIN public.clients c ON c.email = t.customer_email
    WHERE t.status IN ('paid', 'succeeded')
      AND COALESCE(t.stripe_created_at, t.created_at) >= v_start
    GROUP BY COALESCE(c.acquisition_source, 'unknown')
  )
  SELECT
    c.source,
    c.leads,
    c.trials,
    c.customers,
    COALESCE(r.revenue, 0) AS revenue,
    c.total_spend,
    c.customer_count
  FROM client_counts c
  LEFT JOIN revenue_by_source r ON r.source = c.source;
END;
$$;

GRANT EXECUTE ON FUNCTION public.source_metrics(integer) TO authenticated;
