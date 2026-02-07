// Seed the Lovable/Supabase knowledge base table (public.vrp_knowledge) via the vrp-brain-api Edge Function.
//
// Usage:
//   VRP_ADMIN_KEY=... OPENAI_API_KEY=... node scripts/seed-vrp-knowledge.mjs
//
// Optional:
//   VRP_BRAIN_API_URL="https://<project>.supabase.co/functions/v1/vrp-brain-api"
//   KNOWLEDGE_DIRS="docs,README.md,README-IMPORT.md"
//   DRY_RUN=1
//   LIMIT=200
//
// Notes:
// - This script never stores secrets and does not write to Supabase directly (RLS-safe).
// - It generates embeddings with OpenAI and pushes rows through vrp-brain-api:
//   { action:"insert", table:"vrp_knowledge", data:{ content, metadata, embedding } }

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Load .env files (local only). Never commit secrets.
dotenv.config({ path: path.join(repoRoot, ".env.local") });
dotenv.config({ path: path.join(repoRoot, ".env") });

const VRP_BRAIN_API_URL =
  process.env.VRP_BRAIN_API_URL ||
  "https://sbexeqqizazjfsbsgrbd.supabase.co/functions/v1/vrp-brain-api";
const VRP_ADMIN_KEY = process.env.VRP_ADMIN_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const LIMIT = Number(process.env.LIMIT || "0") || 0;

const KNOWLEDGE_DIRS_RAW = process.env.KNOWLEDGE_DIRS || "docs,README.md,README-IMPORT.md";
const KNOWLEDGE_SOURCES = KNOWLEDGE_DIRS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(repoRoot, p));

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536 dims
const MAX_CHARS_PER_CHUNK = Number(process.env.MAX_CHARS_PER_CHUNK || "1600") || 1600;
const MIN_CHARS_PER_CHUNK = Number(process.env.MIN_CHARS_PER_CHUNK || "240") || 240;
const BATCH_SIZE = Math.min(50, Math.max(1, Number(process.env.BATCH_SIZE || "20") || 20));
const INSERT_CONCURRENCY = Math.min(5, Math.max(1, Number(process.env.INSERT_CONCURRENCY || "2") || 2));

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFiles(entryPath) {
  const stat = await fs.stat(entryPath);
  if (stat.isFile()) return [entryPath];

  const out = [];
  const queue = [entryPath];
  while (queue.length) {
    const cur = queue.pop();
    if (!cur) continue;

    const st = await fs.stat(cur);
    if (st.isDirectory()) {
      const children = await fs.readdir(cur);
      for (const c of children) queue.push(path.join(cur, c));
      continue;
    }

    if (st.isFile()) {
      const ext = path.extname(cur).toLowerCase();
      if (ext === ".md" || ext === ".txt") out.push(cur);
    }
  }
  return out.sort();
}

function chunkText({ text, title, sourcePath }) {
  const clean = normalizeText(text);
  if (!clean) return [];

  // Simple paragraph chunker (stable + predictable).
  const paragraphs = clean.split("\n\n").map((p) => p.trim()).filter(Boolean);

  const chunks = [];
  let buf = "";
  let chunkIndex = 0;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed.length >= MIN_CHARS_PER_CHUNK) {
      chunks.push({
        content: title ? `${title}\n\n${trimmed}` : trimmed,
        metadata: {
          source: "repo",
          source_file: path.relative(repoRoot, sourcePath),
          chunk_index: chunkIndex,
        },
      });
      chunkIndex += 1;
    }
    buf = "";
  };

  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
      continue;
    }

    if ((buf.length + 2 + p.length) > MAX_CHARS_PER_CHUNK) {
      flush();
      buf = p;
      continue;
    }

    buf += `\n\n${p}`;
  }

  flush();
  return chunks;
}

async function openAiEmbeddings(inputs) {
  // inputs: string[]
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI embeddings failed (${resp.status}): ${text.slice(0, 240)}`);
  }

  const json = JSON.parse(text);
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map((d) => d.embedding);
}

async function vrpBrainInsert({ content, metadata, embedding }) {
  const resp = await fetch(VRP_BRAIN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": VRP_ADMIN_KEY,
    },
    body: JSON.stringify({
      action: "insert",
      table: "vrp_knowledge",
      data: {
        content,
        metadata,
        embedding,
      },
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`vrp-brain-api insert failed (${resp.status}): ${text.slice(0, 240)}`);
  }

  const json = JSON.parse(text);
  if (!json?.ok) {
    throw new Error(`vrp-brain-api insert error: ${text.slice(0, 240)}`);
  }
  return json;
}

async function main() {
  console.log("🧠 Seed vrp_knowledge via vrp-brain-api\n");
  console.log(`Endpoint: ${VRP_BRAIN_API_URL}`);
  console.log(`Sources: ${KNOWLEDGE_SOURCES.map((p) => path.relative(repoRoot, p)).join(", ")}`);
  console.log(`Model: ${EMBEDDING_MODEL}`);
  console.log(`Dry run: ${DRY_RUN ? "YES" : "no"}`);
  console.log("");

  if (!OPENAI_API_KEY) die("Falta OPENAI_API_KEY (para generar embeddings).");
  if (!VRP_ADMIN_KEY && !DRY_RUN) die("Falta VRP_ADMIN_KEY (header x-admin-key para vrp-brain-api).");

  // Validate sources exist
  for (const src of KNOWLEDGE_SOURCES) {
    if (!(await pathExists(src))) die(`No existe la ruta en KNOWLEDGE_DIRS: ${src}`);
  }

  // Expand sources -> files
  const files = [];
  for (const src of KNOWLEDGE_SOURCES) {
    const expanded = await listMarkdownFiles(src);
    files.push(...expanded);
  }

  if (files.length === 0) die("No encontré archivos para subir.");

  console.log(`📄 Archivos detectados: ${files.length}`);

  // Build chunks
  const items = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const title = `Fuente: ${path.relative(repoRoot, filePath)}`;
    const chunks = chunkText({ text: raw, title, sourcePath: filePath });
    for (const c of chunks) {
      const h = sha256(c.content);
      items.push({
        content: c.content,
        metadata: { ...c.metadata, hash: h },
      });
      if (LIMIT && items.length >= LIMIT) break;
    }
    if (LIMIT && items.length >= LIMIT) break;
  }

  if (items.length === 0) die("No se generaron chunks (texto demasiado corto).");

  console.log(`✂️  Chunks generados: ${items.length}\n`);

  // Generate embeddings in batches
  const rows = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((b) => b.content);

    let embeddings;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        embeddings = await openAiEmbeddings(inputs);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const waitMs = Math.min(15_000, 500 * 2 ** attempt);
        console.warn(`⚠️  Embeddings batch failed (attempt ${attempt}/5): ${msg}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    if (!embeddings) die("No pude generar embeddings (OpenAI).");
    if (embeddings.length !== batch.length) die("OpenAI devolvió un tamaño inesperado de embeddings.");

    for (let j = 0; j < batch.length; j++) {
      rows.push({
        content: batch[j].content,
        metadata: batch[j].metadata,
        embedding: embeddings[j],
      });
    }

    console.log(`✅ Embeddings: ${Math.min(i + BATCH_SIZE, items.length)}/${items.length}`);
  }

  if (DRY_RUN) {
    console.log("\n🟡 DRY_RUN=1: No se insertó nada. Primer chunk:");
    console.log(rows[0]?.content?.slice(0, 500) || "(vacío)");
    return;
  }

  // Insert with small concurrency
  console.log("\n⬆️  Insertando en vrp_knowledge...");
  let inserted = 0;
  let failed = 0;

  const queue = rows.slice();
  const workers = Array.from({ length: INSERT_CONCURRENCY }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        await vrpBrainInsert(row);
        inserted += 1;
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`❌ Insert failed: ${msg}`);
      }
    }
  });

  await Promise.all(workers);

  console.log("\n📌 Resultado:");
  console.log(`- Insertados: ${inserted}`);
  console.log(`- Fallidos: ${failed}`);
  console.log(`- Total: ${rows.length}`);
}

main().catch((e) => {
  console.error("\n❌ Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

