

# Plan: Corregir Bug en unify_identity (Record No Inicializado)

## Problema Confirmado

El error `record "v_existing_client" is not assigned yet` ocurre porque:
- Cuando `p_source` no es "stripe", "paypal", "ghl", o "manychat"
- La función salta directamente a verificar `v_existing_client.id IS NULL`
- Pero el record nunca fue inicializado con un `SELECT INTO`

## Solución

Agregar una variable `v_found boolean := false` para trackear si encontramos un cliente, en lugar de verificar directamente el record.

### Cambios en la Función

```sql
DECLARE
  ...
  v_found boolean := false;  -- NUEVO: flag para tracking
BEGIN
  ...
  
  -- CAMBIO: Usar v_found en lugar de v_existing_client.id IS NULL
  IF p_source = 'stripe' AND p_stripe_customer_id IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE ...;
    v_found := FOUND;  -- FOUND es variable automática de PostgreSQL
    IF v_found THEN v_match_by := 'stripe_customer_id'; END IF;
  ELSIF ...
  END IF;
  
  -- Búsqueda por email solo si NO encontramos antes
  IF NOT v_found AND v_email_normalized IS NOT NULL THEN
    SELECT * INTO v_existing_client FROM clients WHERE ...;
    v_found := FOUND;
    IF v_found THEN v_match_by := 'email'; END IF;
  END IF;
  
  -- Crear o Actualizar basado en v_found
  IF v_found THEN
    -- UPDATE
  ELSE
    -- INSERT
  END IF;
```

## Archivos a Crear

| Archivo | Descripción |
|---------|-------------|
| `supabase/migrations/..._fix_unify_identity.sql` | Migración con la función corregida |

## Verificación Post-Fix

Tu script Python funcionará con cualquier valor de `p_source`:

```python
# ANTES: Falla con p_source="test_script"
# DESPUÉS: Funciona correctamente
supabase.rpc("unify_identity_v2", {
    "p_source": "test_script",  # Ya no crashea
    "p_email": "test@example.com",
    ...
}).execute()
```

