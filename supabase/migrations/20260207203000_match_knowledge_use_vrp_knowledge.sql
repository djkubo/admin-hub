-- Ensure the RAG search function matches the Lovable Cloud bot contract.
-- The bot injects knowledge into public.vrp_knowledge.
--
-- Backwards-compatible: still searches legacy public.knowledge_base so existing RAG content
-- continues to work while vrp_knowledge is being populated.

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
  WITH all_knowledge AS (
    SELECT id, content, embedding FROM public.knowledge_base
    UNION ALL
    SELECT id, content, embedding FROM public.vrp_knowledge
  )
  SELECT
    k.id,
    k.content,
    (1 - (k.embedding <=> query_embedding))::float AS similarity
  FROM all_knowledge k
  WHERE
    k.embedding IS NOT NULL
    AND 1 - (k.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
