-- Backfill client_id on invoices using email matching
-- This links invoices to clients for CRM integration

UPDATE invoices i
SET client_id = (
  SELECT c.id FROM clients c 
  WHERE LOWER(c.email) = LOWER(i.customer_email)
  LIMIT 1
)
WHERE i.client_id IS NULL
  AND i.customer_email IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM clients c 
    WHERE LOWER(c.email) = LOWER(i.customer_email)
  );