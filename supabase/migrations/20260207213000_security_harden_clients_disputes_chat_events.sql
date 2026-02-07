-- ============================================================
-- SECURITY HARDENING (Lovable/Supabase Security Scan)
-- - Prevent public/anon access to PII tables (clients, disputes, chat_events)
-- - Ensure chat_events has RLS enabled
-- - Add explicit deny policy for anon to satisfy automated scanners
-- ============================================================

-- Make sure is_admin() exists and is resilient (won't error if app_admins is missing).
-- We intentionally keep this lightweight: admins are determined by presence in public.app_admins.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.app_admins
    WHERE user_id = auth.uid()
  );
EXCEPTION
  WHEN undefined_table THEN
    RETURN false;
END;
$$;

-- ============================================================
-- CLIENTS (PII)
-- ============================================================
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Remove any direct privileges from anon (scanner considers this "publicly readable").
REVOKE ALL ON TABLE public.clients FROM anon;

-- Drop permissive / legacy policies (some older migrations created public access).
DROP POLICY IF EXISTS "Allow public read access" ON public.clients;
DROP POLICY IF EXISTS "Allow public insert access" ON public.clients;
DROP POLICY IF EXISTS "Allow public update access" ON public.clients;
DROP POLICY IF EXISTS "Allow public delete access" ON public.clients;

DROP POLICY IF EXISTS "Authenticated users can view clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can insert clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can update clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can delete clients" ON public.clients;

DROP POLICY IF EXISTS "Admin can view clients" ON public.clients;
DROP POLICY IF EXISTS "Admin can insert clients" ON public.clients;
DROP POLICY IF EXISTS "Admin can update clients" ON public.clients;
DROP POLICY IF EXISTS "Admin can delete clients" ON public.clients;

DROP POLICY IF EXISTS "block_public_access" ON public.clients;

-- Explicit deny for anon; admin-only access via is_admin().
CREATE POLICY "block_public_access"
ON public.clients
FOR SELECT
TO anon
USING (false);

CREATE POLICY "Admin can view clients"
ON public.clients
FOR SELECT
TO authenticated
USING (public.is_admin());

CREATE POLICY "Admin can insert clients"
ON public.clients
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

CREATE POLICY "Admin can update clients"
ON public.clients
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admin can delete clients"
ON public.clients
FOR DELETE
TO authenticated
USING (public.is_admin());

-- ============================================================
-- DISPUTES (PII / financial)
-- ============================================================
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.disputes FROM anon;

DROP POLICY IF EXISTS "Admin can manage disputes" ON public.disputes;
DROP POLICY IF EXISTS "block_public_access" ON public.disputes;

CREATE POLICY "block_public_access"
ON public.disputes
FOR SELECT
TO anon
USING (false);

CREATE POLICY "Admin can manage disputes"
ON public.disputes
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- ============================================================
-- CHAT_EVENTS (messages/media URLs) - must have RLS enabled
-- ============================================================
ALTER TABLE public.chat_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chat_events FROM anon;

-- Drop legacy / permissive policies that may exist in older environments.
DROP POLICY IF EXISTS "Allow Public Read" ON public.chat_events;
DROP POLICY IF EXISTS "Allow Public Insert" ON public.chat_events;
DROP POLICY IF EXISTS "Admin can manage chat_events" ON public.chat_events;
DROP POLICY IF EXISTS "Admin can read chat_events" ON public.chat_events;
DROP POLICY IF EXISTS "Admin can insert chat_events" ON public.chat_events;
DROP POLICY IF EXISTS "Admin full access chat_events" ON public.chat_events;
DROP POLICY IF EXISTS "Service role full access chat_events" ON public.chat_events;
DROP POLICY IF EXISTS "block_public_access" ON public.chat_events;

CREATE POLICY "block_public_access"
ON public.chat_events
FOR SELECT
TO anon
USING (false);

CREATE POLICY "Admin can manage chat_events"
ON public.chat_events
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Edge Functions often run with service_role; keep a permissive policy for it.
CREATE POLICY "Service role full access chat_events"
ON public.chat_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

