// SEC-143 (api#143): guardas do mirror on-demand de mídia.
//
// Red team: /file/:path* baixa do upstream sem allowlist de extensão, sem
// cap de downloads concorrentes e sem cache negativo — flood barato derruba
// o servidor (egress + disco). Este módulo centraliza os guardas puros;
// a rota (src/routes/compat.ts) consome.
import { relative, isAbsolute } from "node:path";

/** Extensões que a API tem motivo para espelhar (mídia do catálogo). */
const MIRRORABLE_EXT = new Set(["mp3", "bmp", "jpg", "jpeg", "png"]);

/**
 * Path é seguro E tem extensão espelhável? Primeira linha de defesa da rota
 * /file/:path* — nega mirror de qualquer coisa fora do catálogo de mídia.
 */
export function mirrorablePath(path: string): boolean {
  if (!path || path.includes("..") || path.startsWith("/")) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIRRORABLE_EXT.has(ext);
}

/**
 * Defesa em profundidade: o caminho RESOLVIDO no disco continua dentro de
 * mediaDir? (cobre encode duplo / normalização que escape o check textual)
 */
export function escapesMediaDir(mediaDir: string, localPath: string): boolean {
  const rel = relative(mediaDir, localPath);
  return isAbsolute(rel) || rel.startsWith("..");
}

/**
 * Cache negativo com TTL e cap — miss conhecido não re-martela o upstream.
 * (Map com ordenação de inserção: eviction FIFO, simples e suficiente.)
 */
export class NegativeCache {
  private map = new Map<string, number>();
  constructor(
    private ttlMs: number,
    private cap: number,
  ) {}

  has(key: string): boolean {
    const at = this.map.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: string): void {
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, Date.now());
  }

  size(): number {
    return this.map.size;
  }
}

/** Semáforo de contador simples — cap de downloads concorrentes. */
export class Semaphore {
  private held = 0;
  constructor(private max: number) {}

  tryAcquire(): boolean {
    if (this.held >= this.max) return false;
    this.held++;
    return true;
  }

  release(): void {
    if (this.held > 0) this.held--;
  }
}
