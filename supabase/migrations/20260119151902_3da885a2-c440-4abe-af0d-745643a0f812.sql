-- First, set replica identity to allow updates on realtime-enabled table
ALTER TABLE public.clients REPLICA IDENTITY FULL;

-- Step 1: Add UUID id column as new primary key
-- First, drop the existing primary key constraint (email)
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_pkey;

-- Add new UUID id column with default
ALTER TABLE public.clients ADD COLUMN id UUID DEFAULT gen_random_uuid();

-- Set id for existing rows that don't have one
UPDATE public.clients SET id = gen_random_uuid() WHERE id IS NULL;

-- Make id NOT NULL and set as primary key
ALTER TABLE public.clients ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.clients ADD PRIMARY KEY (id);

-- Now we can use the primary key for replica identity
ALTER TABLE public.clients REPLICA IDENTITY DEFAULT;

-- Step 2: Make email nullable with unique constraint (only when not null)
ALTER TABLE public.clients ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX clients_email_unique ON public.clients (email) WHERE email IS NOT NULL;

-- Step 3: Ensure phone is nullable (already is, but explicit)
-- No action needed, phone is already nullable

-- Step 4: Drop ALL existing public RLS policies on clients
DROP POLICY IF EXISTS "Allow public delete access" ON public.clients;
DROP POLICY IF EXISTS "Allow public insert access" ON public.clients;
DROP POLICY IF EXISTS "Allow public read access" ON public.clients;
DROP POLICY IF EXISTS "Allow public update access" ON public.clients;

-- Step 5: Create secure RLS policies for authenticated users only
CREATE POLICY "Authenticated users can view clients"
ON public.clients FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert clients"
ON public.clients FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update clients"
ON public.clients FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated users can delete clients"
ON public.clients FOR DELETE
TO authenticated
USING (true);

-- Step 6: Drop public policies on transactions and add authenticated-only policies
DROP POLICY IF EXISTS "Allow public insert access on transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow public read access on transactions" ON public.transactions;
DROP POLICY IF EXISTS "Allow public update access on transactions" ON public.transactions;

CREATE POLICY "Authenticated users can view transactions"
ON public.transactions FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert transactions"
ON public.transactions FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update transactions"
ON public.transactions FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated users can delete transactions"
ON public.transactions FOR DELETE
TO authenticated
USING (true);