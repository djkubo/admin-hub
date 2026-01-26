-- Add raw_data column to subscriptions table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'raw_data') THEN
        ALTER TABLE subscriptions ADD COLUMN raw_data JSONB DEFAULT '{}'::jsonb;
    END IF;
END $$;
