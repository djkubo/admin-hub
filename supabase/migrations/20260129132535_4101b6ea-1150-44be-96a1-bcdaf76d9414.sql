-- Insert default system settings for governance panel
INSERT INTO public.system_settings (key, value)
VALUES 
  ('auto_dunning_enabled', 'true'),
  ('sync_paused', 'false'),
  ('quiet_hours_start', '21:00'),
  ('quiet_hours_end', '08:00'),
  ('company_name', ''),
  ('timezone', 'America/Mexico_City')
ON CONFLICT (key) DO NOTHING;