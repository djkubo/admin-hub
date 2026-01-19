-- Drop the partial unique index and create a proper one for upsert
DROP INDEX IF EXISTS clients_email_unique;

-- Create a simple unique index on email (handles NULL as unique values)
CREATE UNIQUE INDEX clients_email_key ON public.clients (email);