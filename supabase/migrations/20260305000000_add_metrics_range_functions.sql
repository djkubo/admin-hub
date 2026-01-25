-- Additional metrics RPCs with date ranges
CREATE OR REPLACE FUNCTION public.metrics_mrr(
  start_date timestamptz,
  end_date timestamptz
)
RETURNS TABLE(
  mrr bigint,
  active_customers bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(t.amount), 0)::bigint AS mrr,
    COUNT(DISTINCT lower(t.customer_email)) FILTER (WHERE t.customer_email IS NOT NULL) AS active_customers
  FROM public.transactions t
  WHERE t.status IN ('paid', 'succeeded')
    AND COALESCE(t.stripe_created_at, t.created_at) >= start_date
    AND COALESCE(t.stripe_created_at, t.created_at) <= end_date;
END;
$$;

GRANT EXECUTE ON FUNCTION public.metrics_mrr(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.metrics_churn(
  start_date timestamptz,
  end_date timestamptz
)
RETURNS TABLE(
  churned_customers bigint,
  churn_rate numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period interval := end_date - start_date;
  v_prev_start timestamptz := start_date - v_period;
BEGIN
  RETURN QUERY
  WITH prev_customers AS (
    SELECT DISTINCT lower(customer_email) AS email
    FROM public.transactions
    WHERE customer_email IS NOT NULL
      AND status IN ('paid', 'succeeded')
      AND COALESCE(stripe_created_at, created_at) >= v_prev_start
      AND COALESCE(stripe_created_at, created_at) < start_date
  ),
  current_customers AS (
    SELECT DISTINCT lower(customer_email) AS email
    FROM public.transactions
    WHERE customer_email IS NOT NULL
      AND status IN ('paid', 'succeeded')
      AND COALESCE(stripe_created_at, created_at) >= start_date
      AND COALESCE(stripe_created_at, created_at) <= end_date
  )
  SELECT
    COALESCE(COUNT(prev_customers.email) FILTER (WHERE current_customers.email IS NULL), 0) AS churned_customers,
    CASE
      WHEN COUNT(prev_customers.email) > 0 THEN
        ROUND(
          (COUNT(prev_customers.email) FILTER (WHERE current_customers.email IS NULL)::numeric
            / COUNT(prev_customers.email)::numeric) * 100,
          2
        )
      ELSE 0
    END AS churn_rate
  FROM prev_customers
  LEFT JOIN current_customers USING (email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.metrics_churn(timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.metrics_trial_conversion(
  start_date timestamptz,
  end_date timestamptz
)
RETURNS TABLE(
  trial_count bigint,
  converted_count bigint,
  conversion_rate numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH trials AS (
    SELECT DISTINCT lower(email) AS email
    FROM public.clients
    WHERE email IS NOT NULL
      AND trial_started_at >= start_date
      AND trial_started_at <= end_date
  ),
  conversions AS (
    SELECT DISTINCT lower(email) AS email
    FROM public.clients
    WHERE email IS NOT NULL
      AND converted_at >= start_date
      AND converted_at <= end_date
  )
  SELECT
    COALESCE((SELECT COUNT(*) FROM trials), 0) AS trial_count,
    COALESCE((SELECT COUNT(*) FROM conversions), 0) AS converted_count,
    CASE
      WHEN (SELECT COUNT(*) FROM trials) > 0 THEN
        ROUND(((SELECT COUNT(*) FROM conversions)::numeric / (SELECT COUNT(*) FROM trials)::numeric) * 100, 2)
      ELSE 0
    END AS conversion_rate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.metrics_trial_conversion(timestamptz, timestamptz) TO authenticated;
