-- Enable realtime for sync_runs table to update sync status indicator
ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_runs;