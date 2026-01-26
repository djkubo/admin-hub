# ManyChat Credentials & API Structure

## Credentials (Internal Use Only)

**API Key:** `2187832708134847:9e5a8ee8657c3eb86d9cbcf55d516ab2`  
**Pixel ID:** `2187832708134847`

## API Endpoint

- **Base URL:** `https://api.manychat.com`
- **Authentication:** Bearer token in Authorization header
- **Format:** `Authorization: Bearer {API_KEY}`

## Current Implementation

### Endpoint Used
- `GET /fb/subscriber/findBySystemField?field_name=email&field_value={email}`
- Busca suscriptores uno por uno por email
- Límite: 1 request por email

### Rate Limiting
- Current: 10 req/sec, burst 2
- ManyChat API limit: ~10-20 req/sec (varía por plan)

## API Methods Available

### 1. Find by Email (Current)
```
GET /fb/subscriber/findBySystemField?field_name=email&field_value={email}
```
- Busca un suscriptor por email
- Retorna: `{ status: 'success', data: { subscriber } }`
- Si no encuentra: 404 o 400

### 2. Get Subscriber by ID
```
GET /fb/subscriber/getInfo?subscriber_id={id}
```

### 3. List Subscribers (if available)
```
GET /fb/subscriber/getSubscribers?limit={limit}&after={cursor}
```
- Nota: Verificar si este endpoint existe en la API actual

## Subscriber Data Structure

```typescript
{
  id: string;              // Subscriber ID
  email?: string;
  phone?: string;
  whatsapp_phone?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  tags?: Array<{ name: string } | string>;
  optin_email?: boolean;
  optin_sms?: boolean;
  optin_whatsapp?: boolean;
  custom_fields?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}
```

## Current Sync Logic

1. Busca clientes sin `manychat_subscriber_id`
2. Por cada email, busca en ManyChat API
3. Si encuentra, guarda en `manychat_contacts_raw`
4. Llama a `merge_contact` RPC
5. Actualiza `manychat_subscriber_id` en `clients`

## Performance Issues

- **Muy lento**: 1 request por email = 100 emails = 100 requests
- **Rate limiting**: 10 req/sec = ~6 segundos por 100 emails
- **Para 10,000 clientes**: ~10 minutos mínimo

## Optimization Opportunities

1. **Batch API calls** (si ManyChat lo soporta)
2. **List all subscribers** endpoint (más eficiente)
3. **Parallel processing** (múltiples emails simultáneos)
4. **Cache de resultados** para evitar búsquedas duplicadas

## Secrets Configuration

In Supabase Dashboard → Settings → Secrets:
- `MANYCHAT_API_KEY` = `2187832708134847:9e5a8ee8657c3eb86d9cbcf55d516ab2`
