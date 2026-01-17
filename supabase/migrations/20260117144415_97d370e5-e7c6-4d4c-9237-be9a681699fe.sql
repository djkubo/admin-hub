-- Create clients table for SaaS admin dashboard
CREATE TABLE public.clients (
    email TEXT PRIMARY KEY,
    phone TEXT,
    full_name TEXT,
    status TEXT DEFAULT 'active',
    last_sync TIMESTAMP WITH TIME ZONE DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Create public read policy for quick start
CREATE POLICY "Allow public read access"
ON public.clients
FOR SELECT
TO anon, authenticated
USING (true);

-- Create public insert policy
CREATE POLICY "Allow public insert access"
ON public.clients
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Create public update policy
CREATE POLICY "Allow public update access"
ON public.clients
FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

-- Create public delete policy
CREATE POLICY "Allow public delete access"
ON public.clients
FOR DELETE
TO anon, authenticated
USING (true);

-- Enable realtime for clients table
ALTER PUBLICATION supabase_realtime ADD TABLE public.clients;

-- Insert some sample data
INSERT INTO public.clients (email, phone, full_name, status, last_sync) VALUES
('maria.garcia@empresa.com', '+34 612 345 678', 'María García López', 'active', now() - interval '2 hours'),
('carlos.rodriguez@tech.es', '+34 623 456 789', 'Carlos Rodríguez Martín', 'active', now() - interval '1 day'),
('ana.martinez@startup.io', '+34 634 567 890', 'Ana Martínez Sánchez', 'pending', now() - interval '3 days'),
('david.fernandez@corp.com', '+34 645 678 901', 'David Fernández Ruiz', 'inactive', now() - interval '1 week'),
('laura.lopez@digital.es', '+34 656 789 012', 'Laura López Navarro', 'active', now() - interval '5 hours');