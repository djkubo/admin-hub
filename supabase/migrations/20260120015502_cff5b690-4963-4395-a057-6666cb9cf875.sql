-- Create system_settings table for GHL webhook URL and other configs
CREATE TABLE public.system_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can manage settings
CREATE POLICY "Admin can view system_settings" 
ON public.system_settings 
FOR SELECT 
USING (is_admin());

CREATE POLICY "Admin can insert system_settings" 
ON public.system_settings 
FOR INSERT 
WITH CHECK (is_admin());

CREATE POLICY "Admin can update system_settings" 
ON public.system_settings 
FOR UPDATE 
USING (is_admin())
WITH CHECK (is_admin());

CREATE POLICY "Admin can delete system_settings" 
ON public.system_settings 
FOR DELETE 
USING (is_admin());

-- Insert default GHL webhook URL placeholder
INSERT INTO public.system_settings (key, value) 
VALUES ('ghl_webhook_url', NULL)
ON CONFLICT (key) DO NOTHING;