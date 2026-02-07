-- Ensure the RAG search function matches the Lovable Cloud bot contract.
-- The bot injects knowledge into public.vrp_knowledge and expects match_knowledge to query it.

CREATE OR REPLACE FUNCTION public.match_knowledge(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id bigint,
  content text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    vrp_knowledge.id,
    vrp_knowledge.content,
    (1 - (vrp_knowledge.embedding <=> query_embedding))::float AS similarity
  FROM public.vrp_knowledge
  WHERE
    vrp_knowledge.embedding IS NOT NULL
    AND 1 - (vrp_knowledge.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

