-- Backfill payment_type for existing transactions
-- Process in batches to avoid timeout

-- First, identify first payment per customer
WITH first_payments AS (
  SELECT DISTINCT ON (customer_email)
    id,
    customer_email,
    COALESCE(stripe_created_at, created_at) as first_payment_date
  FROM transactions
  WHERE status IN ('paid', 'succeeded')
    AND customer_email IS NOT NULL
  ORDER BY customer_email, COALESCE(stripe_created_at, created_at) ASC
),
-- Check which customers had trials
trial_customers AS (
  SELECT DISTINCT customer_email
  FROM subscriptions
  WHERE trial_start IS NOT NULL
    AND customer_email IS NOT NULL
)
-- Update first payments: 'new' or 'trial_conversion'
UPDATE transactions t
SET payment_type = CASE 
  WHEN tc.customer_email IS NOT NULL THEN 'trial_conversion'
  ELSE 'new'
END
FROM first_payments fp
LEFT JOIN trial_customers tc ON tc.customer_email = fp.customer_email
WHERE t.id = fp.id
  AND t.payment_type = 'unknown';

-- Update all other successful payments as 'renewal'
UPDATE transactions
SET payment_type = 'renewal'
WHERE status IN ('paid', 'succeeded')
  AND payment_type = 'unknown'
  AND customer_email IS NOT NULL;