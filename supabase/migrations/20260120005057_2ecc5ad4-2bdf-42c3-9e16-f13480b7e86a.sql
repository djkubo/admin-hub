-- Create admin role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

-- Create user_roles table for admin management
CREATE TABLE public.app_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  role app_role NOT NULL DEFAULT 'admin',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- Only admins can see admin table
CREATE POLICY "Admins can view app_admins"
ON public.app_admins FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Create security definer function to check admin status (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_admins
    WHERE user_id = auth.uid()
  );
$$;

-- DROP all existing RLS policies and recreate with is_admin()

-- CLIENTS table
DROP POLICY IF EXISTS "Authenticated users can view clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can insert clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can update clients" ON public.clients;
DROP POLICY IF EXISTS "Authenticated users can delete clients" ON public.clients;

CREATE POLICY "Admin can view clients" ON public.clients FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert clients" ON public.clients FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update clients" ON public.clients FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admin can delete clients" ON public.clients FOR DELETE TO authenticated USING (public.is_admin());

-- TRANSACTIONS table
DROP POLICY IF EXISTS "Authenticated users can view transactions" ON public.transactions;
DROP POLICY IF EXISTS "Authenticated users can insert transactions" ON public.transactions;
DROP POLICY IF EXISTS "Authenticated users can update transactions" ON public.transactions;
DROP POLICY IF EXISTS "Authenticated users can delete transactions" ON public.transactions;

CREATE POLICY "Admin can view transactions" ON public.transactions FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert transactions" ON public.transactions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update transactions" ON public.transactions FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admin can delete transactions" ON public.transactions FOR DELETE TO authenticated USING (public.is_admin());

-- INVOICES table
DROP POLICY IF EXISTS "Authenticated users can view invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can insert invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can update invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can delete invoices" ON public.invoices;

CREATE POLICY "Admin can view invoices" ON public.invoices FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert invoices" ON public.invoices FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update invoices" ON public.invoices FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admin can delete invoices" ON public.invoices FOR DELETE TO authenticated USING (public.is_admin());

-- SUBSCRIPTIONS table
DROP POLICY IF EXISTS "Authenticated users can view subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated users can insert subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated users can update subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "Authenticated users can delete subscriptions" ON public.subscriptions;

CREATE POLICY "Admin can view subscriptions" ON public.subscriptions FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert subscriptions" ON public.subscriptions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update subscriptions" ON public.subscriptions FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admin can delete subscriptions" ON public.subscriptions FOR DELETE TO authenticated USING (public.is_admin());

-- AI_INSIGHTS table
DROP POLICY IF EXISTS "Authenticated users can view ai insights" ON public.ai_insights;
DROP POLICY IF EXISTS "Authenticated users can insert ai insights" ON public.ai_insights;
DROP POLICY IF EXISTS "Authenticated users can update ai insights" ON public.ai_insights;

CREATE POLICY "Admin can view ai_insights" ON public.ai_insights FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert ai_insights" ON public.ai_insights FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can update ai_insights" ON public.ai_insights FOR UPDATE TO authenticated USING (public.is_admin());

-- CLIENT_EVENTS table
DROP POLICY IF EXISTS "Authenticated users can view client events" ON public.client_events;
DROP POLICY IF EXISTS "Authenticated users can insert client events" ON public.client_events;
DROP POLICY IF EXISTS "Authenticated users can delete client events" ON public.client_events;

CREATE POLICY "Admin can view client_events" ON public.client_events FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admin can insert client_events" ON public.client_events FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin can delete client_events" ON public.client_events FOR DELETE TO authenticated USING (public.is_admin());