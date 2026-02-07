type EnvValue = string | undefined;

type RuntimeEnvMap = Record<string, unknown>;

function cleanEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Some runtimes may inject placeholders as strings.
  if (trimmed === "undefined" || trimmed === "null") return undefined;

  return trimmed;
}

function readRuntimeEnv(): RuntimeEnvMap {
  // Lovable Cloud (and some hosting setups) may inject env at runtime.
  const g = globalThis as unknown as {
    __ENV?: unknown;
    env?: unknown;
    process?: { env?: unknown };
  };

  const candidate = g.__ENV ?? g.env ?? g.process?.env;
  if (!candidate || typeof candidate !== "object") return {};
  return candidate as RuntimeEnvMap;
}

const runtimeEnv = readRuntimeEnv();
const runtime = {
  VITE_SUPABASE_URL:
    cleanEnvString(runtimeEnv.VITE_SUPABASE_URL) ??
    cleanEnvString(runtimeEnv.SUPABASE_URL),
  VITE_SUPABASE_PUBLISHABLE_KEY:
    cleanEnvString(runtimeEnv.VITE_SUPABASE_PUBLISHABLE_KEY) ??
    cleanEnvString(runtimeEnv.VITE_SUPABASE_ANON_KEY) ??
    cleanEnvString(runtimeEnv.SUPABASE_PUBLISHABLE_KEY) ??
    cleanEnvString(runtimeEnv.SUPABASE_ANON_KEY),
  VITE_SUPABASE_PROJECT_ID:
    cleanEnvString(runtimeEnv.VITE_SUPABASE_PROJECT_ID) ??
    cleanEnvString(runtimeEnv.SUPABASE_PROJECT_ID),
} as const;

export const env = {
  VITE_SUPABASE_URL:
    (import.meta.env.VITE_SUPABASE_URL as EnvValue) ??
    runtime.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY:
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as EnvValue) ??
    (import.meta.env.VITE_SUPABASE_ANON_KEY as EnvValue) ??
    runtime.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_PROJECT_ID:
    (import.meta.env.VITE_SUPABASE_PROJECT_ID as EnvValue) ??
    runtime.VITE_SUPABASE_PROJECT_ID,
} as const;

const REQUIRED_CLIENT_ENVS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
] as const;

export type RequiredClientEnvKey = (typeof REQUIRED_CLIENT_ENVS)[number];

export function missingSupabaseEnvKeys(): RequiredClientEnvKey[] {
  const missing: RequiredClientEnvKey[] = [];

  for (const key of REQUIRED_CLIENT_ENVS) {
    const value = env[key];
    if (!value) missing.push(key);
  }

  return missing;
}

export function isSupabaseConfigured(): boolean {
  return missingSupabaseEnvKeys().length === 0;
}
