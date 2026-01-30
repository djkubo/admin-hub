-- =============================================
-- SECURITY FIX: Remove public access from sensitive tables
-- =============================================

-- 1. Remove anonymous policies from knowledge_base
DROP POLICY IF EXISTS "Allow anon read" ON public.knowledge_base;
DROP POLICY IF EXISTS "Allow anon insert" ON public.knowledge_base;

-- Update authenticated policy to admin-only
DROP POLICY IF EXISTS "Allow authenticated read" ON public.knowledge_base;
CREATE POLICY "Admin can read knowledge_base" ON public.knowledge_base
  FOR SELECT TO authenticated USING (public.is_admin());

-- 2. Remove public policies from chat_events
DROP POLICY IF EXISTS "Allow Public Read" ON public.chat_events;
DROP POLICY IF EXISTS "Allow Public Insert" ON public.chat_events;

-- Create secure policies for chat_events
CREATE POLICY "Admin can read chat_events" ON public.chat_events
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "Admin can insert chat_events" ON public.chat_events
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "Service role full access chat_events" ON public.chat_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Revoke direct grants from anon role
REVOKE ALL ON TABLE public.knowledge_base FROM anon;
REVOKE ALL ON TABLE public.chat_events FROM anon;