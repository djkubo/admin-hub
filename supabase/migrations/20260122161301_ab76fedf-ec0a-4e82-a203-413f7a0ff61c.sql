-- Asegurar permisos para que la App vea los mensajes
GRANT ALL ON TABLE chat_events TO anon;
GRANT ALL ON TABLE chat_events TO service_role;