# 🔌 Pasos para Conectar a tu Backend

## Opción 1: Variables de Entorno (Recomendado)

### Paso 1: Obtén las Credenciales

Ve a **Lovable Cloud → Settings → Environment Variables** y copia:

1. **SUPABASE_URL** (o `VITE_SUPABASE_URL`)
   - Formato: `https://xxxxx.supabase.co`

2. **SUPABASE_SERVICE_ROLE_KEY** (o `VITE_SUPABASE_SERVICE_ROLE_KEY`)
   - Formato: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (JWT largo)

3. **SUPABASE_PUBLISHABLE_KEY** (opcional, para verificar)
   - Formato: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` (JWT largo)

### Paso 2: Configura las Variables

**Opción A - Variables de entorno temporales:**
```bash
export VITE_SUPABASE_URL="https://tu-proyecto.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
export VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Opción B - Archivo .env.local:**
```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

⚠️ **Nota de Seguridad:** Nunca compartas las credenciales en código fuente. Usa siempre variables de entorno.

---

## Opción 2: Usar Archivo Local

### Paso 1: Crea Archivo Temporal

```bash
cd tu-proyecto
nano .env.local
```

### Paso 2: Agrega las Credenciales

```env
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Paso 3: Ejecuta Script de Prueba

```bash
node scripts/test-supabase-connection.js
```

Esto verificará la conexión sin exponer las keys.

---

## Opción 3: Ya Tienes las Credenciales en .env

Si ya tienes un `.env` con las credenciales:

```bash
# Verifica que existan
cat .env | grep SUPABASE
```

Si están ahí, los scripts las usarán automáticamente.

---

## 🎯 Qué Puedes Hacer con las Credenciales

Una vez conectado:

1. ✅ **Verificar conexión** - Confirmar que funciona
2. ✅ **Analizar datos** - Contar registros, ver estructura
3. ✅ **Preparar migración** - Exportar schema y datos
4. ✅ **Crear backups** - Generar SQL dumps
5. ✅ **Optimizar** - Identificar problemas de rendimiento

---

## ⚡ Método Más Rápido

1. Ve a Lovable Cloud → Settings → Environment Variables
2. Copia las 3 credenciales
3. Configúralas como variables de entorno
4. Ejecuta tus scripts

**Las credenciales se obtienen dinámicamente de tus variables de entorno.**
