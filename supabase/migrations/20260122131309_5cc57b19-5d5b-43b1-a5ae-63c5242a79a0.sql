-- Create knowledge_base table for AI vector search
CREATE TABLE public.knowledge_base (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index for fast vector similarity search
CREATE INDEX knowledge_base_embedding_idx ON public.knowledge_base 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Enable RLS
ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

-- Policy: Allow authenticated users to read
CREATE POLICY "Allow authenticated read" ON public.knowledge_base
  FOR SELECT TO authenticated USING (true);

-- Policy: Allow service role full access (for bot to insert)
CREATE POLICY "Allow service role all" ON public.knowledge_base
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Add to realtime if needed
COMMENT ON TABLE public.knowledge_base IS 'Knowledge base for AI vector search - used by Python bot';