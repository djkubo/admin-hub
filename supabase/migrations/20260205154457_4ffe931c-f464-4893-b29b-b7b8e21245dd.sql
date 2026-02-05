-- Create RPC for subscription metrics (server-side aggregation for accurate totals)
CREATE OR REPLACE FUNCTION get_subscription_metrics()
RETURNS TABLE (
  total_count bigint,
  active_count bigint,
  trialing_count bigint,
  past_due_count bigint,
  unpaid_count bigint,
  canceled_count bigint,
  paused_count bigint,
  incomplete_count bigint,
  mrr bigint,
  at_risk_amount bigint,
  stripe_count bigint,
  paypal_count bigint
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint AS total_count,
    COUNT(*) FILTER (WHERE status = 'active')::bigint AS active_count,
    COUNT(*) FILTER (WHERE status = 'trialing')::bigint AS trialing_count,
    COUNT(*) FILTER (WHERE status = 'past_due')::bigint AS past_due_count,
    COUNT(*) FILTER (WHERE status = 'unpaid')::bigint AS unpaid_count,
    COUNT(*) FILTER (WHERE status IN ('canceled', 'cancelled'))::bigint AS canceled_count,
    COUNT(*) FILTER (WHERE status = 'paused')::bigint AS paused_count,
    COUNT(*) FILTER (WHERE status LIKE 'incomplete%')::bigint AS incomplete_count,
    COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)::bigint AS mrr,
    COALESCE(SUM(amount) FILTER (WHERE status IN ('past_due', 'unpaid')), 0)::bigint AS at_risk_amount,
    COUNT(*) FILTER (WHERE COALESCE(provider, 'stripe') = 'stripe')::bigint AS stripe_count,
    COUNT(*) FILTER (WHERE provider = 'paypal')::bigint AS paypal_count
  FROM public.subscriptions;
END;
$$;

-- Create RPC for revenue by plan (for charts)
CREATE OR REPLACE FUNCTION get_revenue_by_plan(limit_count int DEFAULT 10)
RETURNS TABLE (
  plan_name text,
  subscription_count bigint,
  total_revenue bigint,
  percentage numeric
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  total_mrr bigint;
BEGIN
  -- Get total MRR first
  SELECT COALESCE(SUM(amount), 0) INTO total_mrr
  FROM public.subscriptions
  WHERE status IN ('active', 'trialing');
  
  RETURN QUERY
  SELECT
    s.plan_name,
    COUNT(*)::bigint AS subscription_count,
    SUM(s.amount)::bigint AS total_revenue,
    CASE WHEN total_mrr > 0 
         THEN ROUND((SUM(s.amount)::numeric / total_mrr::numeric) * 100, 2)
         ELSE 0 
    END AS percentage
  FROM public.subscriptions s
  WHERE s.status IN ('active', 'trialing')
  GROUP BY s.plan_name
  ORDER BY total_revenue DESC
  LIMIT limit_count;
END;
$$;