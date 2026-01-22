-- Permitir inserción pública para seeding
CREATE POLICY "Allow anon insert" ON public.knowledge_base
FOR INSERT TO anon WITH CHECK (true);

-- Permitir lectura pública para el bot
CREATE POLICY "Allow anon read" ON public.knowledge_base
FOR SELECT TO anon USING (true);

-- Asegurar permisos de grants
GRANT SELECT, INSERT, UPDATE ON TABLE public.knowledge_base TO anon;
GRANT ALL ON TABLE public.knowledge_base TO service_role;
GRANT USAGE, SELECT ON SEQUENCE knowledge_base_id_seq TO anon;
GRANT ALL ON SEQUENCE knowledge_base_id_seq TO service_role;