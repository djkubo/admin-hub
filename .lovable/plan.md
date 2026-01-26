
# Plan: Corregir Error de Autenticación "Auth session missing"

## Diagnóstico

El error ocurre porque `supabase.functions.invoke` no está pasando correctamente el token JWT al servidor, aunque localmente la sesión parece válida.

**Logs del servidor:**
```
User validation failed | error="Auth session missing!", code=400
```

**Logs del cliente:**
```
[AdminAPI] Session valid, calling function...
```

El SDK de Supabase v2.x tiene un comportamiento inconsistente donde `functions.invoke` no siempre incluye el `Authorization` header automáticamente.

---

## Solución

Modificar `invokeWithAdminKey` para pasar **explícitamente** el header `Authorization` con el access token de la sesión:

```typescript
// ANTES (no siempre pasa el header)
const { data, error } = await supabase.functions.invoke(functionName, {
  body,
});

// DESPUÉS (siempre pasa el header)
const { data, error } = await supabase.functions.invoke(functionName, {
  body,
  headers: {
    Authorization: `Bearer ${session.access_token}`
  }
});
```

---

## Archivo a Modificar

| Archivo | Cambio |
|---------|--------|
| `src/lib/adminApi.ts` | Añadir header `Authorization` explícito en `functions.invoke` |

---

## Código Propuesto

```typescript
export async function invokeWithAdminKey<
  T = Record<string, unknown>,
  B extends Record<string, unknown> = Record<string, unknown>
>(
  functionName: string,
  body?: B
): Promise<T | null> {
  try {
    console.log(`[AdminAPI] Invoking ${functionName}`, body ? 'with body' : 'without body');
    
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError) {
      console.error('[AdminAPI] Session error:', sessionError);
      return { success: false, error: `Session error: ${sessionError.message}` } as T;
    }
    
    if (!session) {
      console.error('[AdminAPI] No active session');
      return { success: false, error: 'No active session. Please log in again.' } as T;
    }

    // SOLUCIÓN: Pasar explícitamente el Authorization header
    console.log(`[AdminAPI] Session valid, token length: ${session.access_token.length}`);
    
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: {
        Authorization: `Bearer ${session.access_token}`
      }
    });

    // ... resto del código igual
  }
}
```

---

## Por Qué Esto Funciona

1. **Garantía explícita**: No dependemos del comportamiento automático del SDK
2. **Token fresco**: Usamos `session.access_token` directamente de la sesión validada
3. **Mismo patrón que funciona**: Otras funciones como `sync-command-center` reciben el header correctamente

---

## Resultado Esperado

Con este cambio, cada llamada a Edge Functions incluirá el JWT correctamente, eliminando el error "Auth session missing".
