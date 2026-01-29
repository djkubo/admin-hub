-- Fase 5: Sistema de Listas de Difusión (Broadcast Lists)

-- Tabla principal de listas de difusión
CREATE TABLE public.broadcast_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  member_count INTEGER DEFAULT 0,
  last_broadcast_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tabla de miembros de cada lista
CREATE TABLE public.broadcast_list_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES public.broadcast_lists(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(list_id, client_id)
);

-- Tabla de mensajes enviados a listas
CREATE TABLE public.broadcast_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES public.broadcast_lists(id) ON DELETE CASCADE,
  message_content TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT,
  status TEXT DEFAULT 'pending',
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Índices para performance
CREATE INDEX idx_broadcast_list_members_list_id ON public.broadcast_list_members(list_id);
CREATE INDEX idx_broadcast_list_members_client_id ON public.broadcast_list_members(client_id);
CREATE INDEX idx_broadcast_messages_list_id ON public.broadcast_messages(list_id);
CREATE INDEX idx_broadcast_messages_status ON public.broadcast_messages(status);

-- Habilitar RLS
ALTER TABLE public.broadcast_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_messages ENABLE ROW LEVEL SECURITY;

-- Políticas RLS (acceso solo para admins autenticados)
CREATE POLICY "Admins can manage broadcast_lists" 
ON public.broadcast_lists FOR ALL 
USING (public.is_admin());

CREATE POLICY "Admins can manage broadcast_list_members" 
ON public.broadcast_list_members FOR ALL 
USING (public.is_admin());

CREATE POLICY "Admins can manage broadcast_messages" 
ON public.broadcast_messages FOR ALL 
USING (public.is_admin());

-- Trigger para actualizar updated_at
CREATE TRIGGER update_broadcast_lists_updated_at
BEFORE UPDATE ON public.broadcast_lists
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Función para actualizar member_count automáticamente
CREATE OR REPLACE FUNCTION public.update_broadcast_list_member_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.broadcast_lists 
    SET member_count = member_count + 1 
    WHERE id = NEW.list_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.broadcast_lists 
    SET member_count = member_count - 1 
    WHERE id = OLD.list_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- Trigger para mantener member_count sincronizado
CREATE TRIGGER sync_broadcast_list_member_count
AFTER INSERT OR DELETE ON public.broadcast_list_members
FOR EACH ROW
EXECUTE FUNCTION public.update_broadcast_list_member_count();