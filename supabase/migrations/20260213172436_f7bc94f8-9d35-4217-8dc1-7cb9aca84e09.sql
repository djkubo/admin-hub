
-- Fix kpi_new_customers: drop parameterless version, recreate with p_range
DROP FUNCTION IF EXISTS public.kpi_new_customers();
DROP FUNCTION IF EXISTS public.kpi_new_customers(text, text, text);

CREATE OR REPLACE FUNCTION public.kpi_new_customers(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(currency text, new_customer_count bigint, total_revenue bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  v_end := now();
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := p_start_date::timestamptz;
    v_end   := p_end_date::timestamptz;
  ELSIF p_range = 'today' THEN
    v_start := date_trunc('day', now());
  ELSIF p_range = '7d' THEN
    v_start := now() - interval '7 days';
  ELSIF p_range = 'month' THEN
    v_start := now() - interval '1 month';
  ELSE
    v_start := now() - interval '10 years';
  END IF;

  RETURN QUERY
  WITH first_payment AS (
    SELECT customer_email,
           COALESCE(LOWER(t.currency), 'usd') AS cur,
           MIN(t.stripe_created_at) AS first_at,
           MIN(t.amount) AS first_amount
    FROM transactions t
    WHERE t.status IN ('paid','succeeded')
      AND t.customer_email IS NOT NULL
    GROUP BY customer_email, COALESCE(LOWER(t.currency), 'usd')
  )
  SELECT fp.cur AS currency,
         COUNT(*)::bigint AS new_customer_count,
         COALESCE(SUM(fp.first_amount), 0)::bigint AS total_revenue
  FROM first_payment fp
  WHERE fp.first_at >= v_start AND fp.first_at <= v_end
  GROUP BY fp.cur;
END;
$$;

-- Create kpi_trials_started
DROP FUNCTION IF EXISTS public.kpi_trials_started(text, text, text);

CREATE OR REPLACE FUNCTION public.kpi_trials_started(
  p_range text DEFAULT 'today',
  p_start_date text DEFAULT NULL,
  p_end_date text DEFAULT NULL
)
RETURNS TABLE(trial_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_end   timestamptz;
BEGIN
  v_end := now();
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL THEN
    v_start := p_start_date::timestamptz;
    v_end   := p_end_date::timestamptz;
  ELSIF p_range = 'today' THEN
    v_start := date_trunc('day', now());
  ELSIF p_range = '7d' THEN
    v_start := now() - interval '7 days';
  ELSIF p_range = 'month' THEN
    v_start := now() - interval '1 month';
  ELSE
    v_start := now() - interval '10 years';
  END IF;

  RETURN QUERY
  SELECT COUNT(*)::bigint AS trial_count
  FROM subscriptions s
  WHERE s.trial_start IS NOT NULL
    AND s.trial_start >= v_start
    AND s.trial_start <= v_end;
END;
$$;

-- Grant execute to authenticated and anon (dashboard needs it)
GRANT EXECUTE ON FUNCTION public.kpi_new_customers(text, text, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.kpi_trials_started(text, text, text) TO authenticated, anon;
