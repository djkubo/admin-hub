-- Create subscriptions table for plan analytics
CREATE TABLE public.subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  customer_email TEXT,
  plan_name TEXT NOT NULL,
  plan_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'usd',
  interval TEXT DEFAULT 'month',
  status TEXT NOT NULL,
  current_period_start TIMESTAMP WITH TIME ZONE,
  current_period_end TIMESTAMP WITH TIME ZONE,
  canceled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Authenticated users can view subscriptions"
ON public.subscriptions FOR SELECT
USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert subscriptions"
ON public.subscriptions FOR INSERT
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update subscriptions"
ON public.subscriptions FOR UPDATE
USING (auth.role() = 'authenticated')
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can delete subscriptions"
ON public.subscriptions FOR DELETE
USING (auth.role() = 'authenticated');

-- Index for analytics queries
CREATE INDEX idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX idx_subscriptions_plan_name ON public.subscriptions(plan_name);
CREATE INDEX idx_subscriptions_customer_email ON public.subscriptions(customer_email);