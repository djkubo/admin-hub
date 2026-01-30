# 🚀 Obtener Credenciales Rápido

## Método Más Rápido (2 minutos)

### Paso 1: Abre Lovable Cloud
1. Ve a: **https://cloud.lovable.dev**
2. Inicia sesión si es necesario

### Paso 2: Ve a Environment Variables
1. Click en tu proyecto
2. **Settings** (engranaje ⚙️)
3. **Environment Variables**

### Paso 3: Busca y Copia

Busca estas 3 variables (usa Ctrl+F para buscar):

#### 1. SUPABASE_URL
- Busca: `SUPABASE_URL` o `VITE_SUPABASE_URL`
- Haz clic en el 👁️ para revelar
- Copia el valor completo
- Formato: `https://xxxxx.supabase.co`

#### 2. SUPABASE_SERVICE_ROLE_KEY ⭐ (IMPORTANTE)
- Busca: `SUPABASE_SERVICE_ROLE_KEY` o `VITE_SUPABASE_SERVICE_ROLE_KEY`
- Haz clic en el 👁️ para revelar
- Copia el valor completo
- Formato: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (JWT muy largo)

#### 3. SUPABASE_PUBLISHABLE_KEY (opcional)
- Busca: `VITE_SUPABASE_PUBLISHABLE_KEY`
- Haz clic en el 👁️ para revelar
- Copia el valor completo

### Paso 4: Configura Variables de Entorno

Configura las credenciales como variables de entorno:

```bash
export VITE_SUPABASE_URL="https://tu-proyecto.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

O agrégalas a tu archivo `.env.local`:

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Método Alternativo: Desde Consola del Navegador

Si no encuentras las variables en Environment Variables:

1. **Abre DevTools** (F12)
2. **Ve a la pestaña "Console"**
3. **Pega este código:**

```javascript
// Obtener credenciales desde el navegador
const env = window.__ENV || window.process?.env || {};
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || localStorage.getItem('SUPABASE_URL');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_SERVICE_ROLE_KEY || localStorage.getItem('SERVICE_ROLE_KEY');
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || localStorage.getItem('PUBLISHABLE_KEY');

console.log('SUPABASE_URL:', supabaseUrl);
console.log('SERVICE_ROLE_KEY:', serviceKey);
console.log('PUBLISHABLE_KEY:', publishableKey);
```

4. **Presiona Enter**
5. **Copia los valores que aparezcan**

---

## Método 3: Desde Network Tab

1. **Abre DevTools** (F12)
2. **Ve a "Network"**
3. **Recarga la página**
4. **Busca requests a "supabase.co"**
5. **Click en cualquier request**
6. **Ve a "Headers"**
7. **Busca "apikey" o "Authorization"**
8. **Ahí verás las keys**

---

## ⚡ Método Más Rápido de Todos

**Solo necesito el SERVICE_ROLE_KEY:**

1. Ve a Lovable Cloud → Settings → Environment Variables
2. Busca: `SUPABASE_SERVICE_ROLE_KEY`
3. Click en 👁️
4. Copia y configura como variable de entorno

---

## 🔒 Seguridad

Después de que termine:
1. Puedes revocar la Service Role Key
2. Crear una nueva en Supabase Dashboard
3. Actualizar en Lovable Cloud

**Nota:** Nunca compartas credenciales en código. Siempre usa variables de entorno.
