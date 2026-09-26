// The dense lane's model (EXP-015b): granite-embedding-small-english-r2, q8, in-process via transformers.js.
// Vectors are keyed by MODEL_ID in `vecs`; a swap re-embeds and never mixes.
import { pipeline, env } from "@huggingface/transformers";
import type { DatabaseSync } from "node:sqlite";

export const MODEL_ID = "onnx-community/granite-embedding-small-english-r2-ONNX";
export const DIM = 384;
let ex: any;
export async function embedder(cacheDir: string) {
  env.cacheDir = cacheDir;
  ex ??= await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  return ex;
}
export async function embed(texts: string[], cacheDir: string): Promise<Float32Array[]> {
  const e = await embedder(cacheDir);
  const t = await e(texts, { pooling: "cls", normalize: true, truncation: true });
  const flat: Float32Array = t.data, n = texts.length, dim = flat.length / n;
  const out = []; for (let i = 0; i < n; i++) out.push(flat.slice(i * dim, (i + 1) * dim));
  return out;
}
export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

// Embed every chunk that has no vector for MODEL_ID, in batches, one transaction per batch.
export async function embedPending(db: DatabaseSync, cacheDir: string, opts: { batch?: number; limit?: number; onBatch?: (done: number, total: number) => void } = {}) {
  const batch = opts.batch ?? 32;
  const total = (db.prepare(`SELECT COUNT(*) n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vecs v WHERE v.chunk_id = c.id AND v.model_id = ?)`).get(MODEL_ID) as any).n as number;
  const todo = Math.min(total, opts.limit ?? total);
  const sel = db.prepare(`SELECT c.id, c.text FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM vecs v WHERE v.chunk_id = c.id AND v.model_id = ?) ORDER BY c.id LIMIT ?`);
  const ins = db.prepare("INSERT OR IGNORE INTO vecs(chunk_id, model_id, emb) VALUES (?, ?, ?)");
  let done = 0;
  while (done < todo) {
    const rows = sel.all(MODEL_ID, Math.min(batch, todo - done)) as { id: number; text: string }[];
    if (!rows.length) break;
    const vs = await embed(rows.map(r => r.text), cacheDir);
    db.exec("BEGIN");
    try { rows.forEach((r, i) => ins.run(r.id, MODEL_ID, toBlob(vs[i]))); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    done += rows.length; opts.onBatch?.(done, total);
  }
  return { embedded: done, pending: total - done };
}
