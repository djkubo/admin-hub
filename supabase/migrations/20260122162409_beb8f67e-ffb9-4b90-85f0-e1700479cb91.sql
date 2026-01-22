-- DESBLOQUEAR LECTURA PARA LA APP
CREATE POLICY "Allow Public Read" ON public.chat_events
FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Allow Public Insert" ON public.chat_events
FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Recalcular permisos
GRANT ALL ON TABLE public.chat_events TO anon;
GRANT ALL ON TABLE public.chat_events TO service_role;