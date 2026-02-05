-- RPC: get_revenue_pipeline_stats
-- Server-side computation for recovery, trials, and winback segments
-- Supports pagination and returns accurate totals

CREATE OR REPLACE FUNCTION public.get_revenue_pipeline_stats(
  p_type TEXT DEFAULT 'recovery',  -- 'recovery', 'trial', 'winback'
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_total_debt NUMERIC := 0;
  v_total_trials_expiring NUMERIC := 0;
  v_total_winback NUMERIC := 0;
  v_recovery_count INT := 0;
  v_trial_count INT := 0;
  v_winback_count INT := 0;
  v_items JSONB;
BEGIN
  -- Calculate totals for all segments (always computed for summary cards)
  
  -- RECOVERY: Clients with failed transactions or in recovery_queue
  SELECT 
    COUNT(DISTINCT c.id),
    COALESCE(SUM(DISTINCT rq.amount_due), 0) / 100.0
  INTO v_recovery_count, v_total_debt
  FROM clients c
  INNER JOIN recovery_queue rq ON rq.client_id = c.id
  WHERE rq.status IN ('pending', 'retry_scheduled', 'notified');

  -- TRIALS EXPIRING: Active trials ending within 3 days
  SELECT 
    COUNT(DISTINCT s.id),
    COALESCE(SUM(s.amount), 0) / 100.0
  INTO v_trial_count, v_total_trials_expiring
  FROM subscriptions s
  WHERE s.status = 'trialing'
    AND s.trial_end IS NOT NULL
    AND s.trial_end BETWEEN NOW() AND NOW() + INTERVAL '3 days';

  -- WINBACK: Churned customers
  SELECT 
    COUNT(*),
    COALESCE(SUM(total_spend), 0) / 100.0
  INTO v_winback_count, v_total_winback
  FROM clients
  WHERE lifecycle_stage = 'CHURN';

  -- Fetch paginated list based on type
  IF p_type = 'recovery' THEN
    SELECT jsonb_agg(row_to_json(r))
    INTO v_items
    FROM (
      SELECT 
        c.id,
        c.email,
        c.full_name,
        c.phone,
        c.phone_e164,
        c.lifecycle_stage,
        c.revenue_score,
        c.total_spend,
        rq.amount_due / 100.0 AS revenue_at_risk,
        rq.status AS queue_status,
        rq.retry_at,
        rq.attempt_count,
        rq.last_attempt_at,
        rq.notification_sent_at,
        'recovery' AS pipeline_type,
        (
          SELECT MAX(ce.created_at) 
          FROM client_events ce 
          WHERE ce.client_id = c.id 
            AND ce.event_type = 'custom'
        ) AS last_contact_at
      FROM clients c
      INNER JOIN recovery_queue rq ON rq.client_id = c.id
      WHERE rq.status IN ('pending', 'retry_scheduled', 'notified')
      ORDER BY rq.amount_due DESC
      LIMIT p_limit OFFSET p_offset
    ) r;
    
  ELSIF p_type = 'trial' THEN
    SELECT jsonb_agg(row_to_json(r))
    INTO v_items
    FROM (
      SELECT 
        c.id,
        c.email,
        c.full_name,
        c.phone,
        c.phone_e164,
        c.lifecycle_stage,
        c.revenue_score,
        c.total_spend,
        s.amount / 100.0 AS revenue_at_risk,
        s.trial_end,
        EXTRACT(EPOCH FROM (s.trial_end - NOW())) / 86400 AS days_until_expiry,
        NULL::TEXT AS queue_status,
        'trial_expiring' AS pipeline_type,
        (
          SELECT MAX(ce.created_at) 
          FROM client_events ce 
          WHERE ce.client_id = c.id 
            AND ce.event_type = 'custom'
        ) AS last_contact_at
      FROM subscriptions s
      INNER JOIN clients c ON c.stripe_customer_id = s.stripe_customer_id 
                           OR c.email = s.customer_email
      WHERE s.status = 'trialing'
        AND s.trial_end IS NOT NULL
        AND s.trial_end BETWEEN NOW() AND NOW() + INTERVAL '3 days'
      ORDER BY s.trial_end ASC
      LIMIT p_limit OFFSET p_offset
    ) r;
    
  ELSIF p_type = 'winback' THEN
    SELECT jsonb_agg(row_to_json(r))
    INTO v_items
    FROM (
      SELECT 
        c.id,
        c.email,
        c.full_name,
        c.phone,
        c.phone_e164,
        c.lifecycle_stage,
        c.revenue_score,
        c.total_spend / 100.0 AS revenue_at_risk,
        NULL::TEXT AS queue_status,
        'winback' AS pipeline_type,
        (
          SELECT MAX(ce.created_at) 
          FROM client_events ce 
          WHERE ce.client_id = c.id 
            AND ce.event_type = 'custom'
        ) AS last_contact_at
      FROM clients c
      WHERE c.lifecycle_stage = 'CHURN'
      ORDER BY c.total_spend DESC NULLS LAST
      LIMIT p_limit OFFSET p_offset
    ) r;
  END IF;

  -- Build result
  v_result := jsonb_build_object(
    'summary', jsonb_build_object(
      'total_debt', v_total_debt,
      'total_trials_expiring', v_total_trials_expiring,
      'total_winback', v_total_winback,
      'recovery_count', v_recovery_count,
      'trial_count', v_trial_count,
      'winback_count', v_winback_count
    ),
    'items', COALESCE(v_items, '[]'::jsonb),
    'pagination', jsonb_build_object(
      'limit', p_limit,
      'offset', p_offset,
      'total', CASE p_type
        WHEN 'recovery' THEN v_recovery_count
        WHEN 'trial' THEN v_trial_count
        WHEN 'winback' THEN v_winback_count
        ELSE 0
      END
    )
  );

  RETURN v_result;
END;
$$;

-- Grant access
GRANT EXECUTE ON FUNCTION public.get_revenue_pipeline_stats(TEXT, INT, INT) TO authenticated;