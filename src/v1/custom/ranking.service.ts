import type BetterSqlite3 from "better-sqlite3";

/**
 * Ranking e Gamificação (F1..F3) — SPEC validada 16/09.
 *
 * Pilares de pontos (decisão #1 do Ezequias: mantidos):
 * - publish: publicar coletânea pública (+10)
 * - use_received: coletânea usada por outro usuário, 1x/user (+5)
 * - track_complete: faixa com letra completa + áudio (+2)
 * - cover: capa personalizada (+1)
 * - favorited: coletânea favoritada (+3)
 * - weekly_task: tarefa semanal (bônus variável)
 *
 * Anti-spam (SPEC §2): uso conta 1x/user×coletânea (PK); padrão anômalo congela.
 * Ranking GLOBAL (decisão #3), coletâneas oficiais não pontuam (#4),
 * sem anonimato (#7), display name nunca email.
 */

export const POINTS = {
  publish: 10,
  use_received: 5,
  track_complete: 2,
  cover: 1,
  favorited: 3,
} as const;

export type PointReason = keyof typeof POINTS | "weekly_task" | "badge";

/** Limite anti-spam: mais que N publicações em JanelaMinutos = congelar. */
export const ANOMALY_MAX_PUBLISHES = 5;
export const ANOMALY_WINDOW_MINUTES = 30;

/** Aceita a conexão better-sqlite3 real (ou qualquer subtipo estrutural). */
export type DbLike = BetterSqlite3.Database;

/**
 * Registra uso de coletânea (F1). 1x por user×collection (PK).
 * Credita use_received ao DONO (não a quem usou). Idempotente.
 * Retorna true se o uso era novo (primeira vez), false se já existia.
 */
export function recordCollectionUse(
  db: DbLike,
  userId: number,
  collectionId: number,
): boolean {
  const owner = db
    .prepare(
      `SELECT owner_id FROM custom_collections WHERE id_collection = ? AND visibility = 'public'`,
    )
    .get(collectionId) as { owner_id: number | null } | undefined;
  if (!owner || owner.owner_id == null || owner.owner_id === userId) {
    // Não existe, é privada, órfã (oficial) ou o usuário usou a própria.
    return false;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO collection_uses (user_id, collection_id) VALUES (?, ?)`,
  );
  const result = insert.run(userId, collectionId);
  if (result.changes === 0) {
    return false; // já usou antes — idempotente (anti-spam 1x)
  }

  creditPoints(db, owner.owner_id, "use_received", collectionId);
  return true;
}

/**
 * Credita pontos ao usuário, a menos que esteja congelado (anti-spam).
 */
export function creditPoints(
  db: DbLike,
  userId: number,
  reason: PointReason,
  refId?: number,
  multiplier = 1,
  pointsOverride?: number,
): boolean {
  if (isFrozen(db, userId)) return false;
  const base = reason in POINTS ? POINTS[reason as keyof typeof POINTS] : 0;
  const points = pointsOverride ?? Math.ceil(base * multiplier);
  db.prepare(
    `INSERT INTO contrib_points (user_id, points, reason, ref_id) VALUES (?, ?, ?, ?)`,
  ).run(userId, points, reason, refId ?? null);
  return true;
}

/**
 * Detecta padrão anômalo de publicação e congela até moderação (SPEC §2).
 */
export function checkAnomalyAndFreeze(db: DbLike, userId: number): boolean {
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM contrib_points
       WHERE user_id = ? AND reason = 'publish'
         AND created_at > datetime('now', '-' || ? || ' minutes')`,
    )
    .get(userId, ANOMALY_WINDOW_MINUTES) as { n: number };
  if (recent.n > ANOMALY_MAX_PUBLISHES) {
    db.prepare(
      `INSERT OR IGNORE INTO point_freeze (user_id, reason) VALUES (?, ?)`,
    ).run(userId, "anomalia: publicações em rajada");
    return true;
  }
  return false;
}

export function isFrozen(db: DbLike, userId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM point_freeze WHERE user_id = ?`).get(userId) !=
    null
  );
}

export function unfreeze(db: DbLike, userId: number): void {
  db.prepare(`DELETE FROM point_freeze WHERE user_id = ?`).run(userId);
}

/**
 * Ranking global (decisão #3). Janela: 'week' (corrente, ISO semana começando
 * segunda 00:00 UTC) ou 'all'. Desempate: ponto mais antigo primeiro (SPEC RF-3).
 * Exclui congelados. Sem anonimato (#7): display name = author_name do user.
 */
export function getRanking(
  db: DbLike,
  window: "week" | "all",
  limit = 50,
): Array<{
  position: number;
  user_id: number;
  display_name: string | null;
  total: number;
}> {
  const since =
    window === "week" ? `AND p.created_at > datetime('now', '-7 days')` : "";
  const rows = db
    .prepare(
      `SELECT p.user_id,
              COALESCE(u.display_name, 'Usuário ' || p.user_id) AS display_name,
              SUM(p.points) AS total,
              MIN(p.created_at) AS first_point
       FROM contrib_points p
       JOIN custom_users u ON u.id_user = p.user_id
       WHERE 1=1 ${since}
         AND p.user_id NOT IN (SELECT user_id FROM point_freeze)
       GROUP BY p.user_id
       ORDER BY total DESC, first_point ASC
       LIMIT ?`,
    )
    .all(limit);
  type RankRow = {
    user_id: number;
    display_name: string;
    total: number;
    first_point: string;
  };
  return (rows as RankRow[]).map((r, i) => ({
    position: i + 1,
    user_id: r.user_id,
    display_name: r.display_name,
    total: r.total,
  }));
}

/** Posição do próprio usuário numa janela (null se não pontuou). */
export function getUserPosition(
  db: DbLike,
  userId: number,
  window: "week" | "all",
): { position: number; total: number } | null {
  const full = getRanking(db, window, 1_000_000);
  const found = full.find((r) => r.user_id === userId);
  return found ? { position: found.position, total: found.total } : null;
}

/** Concede badge (idempotente). Retorna true se era nova. */
export function grantBadge(db: DbLike, userId: number, badge: string): boolean {
  const r = db
    .prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge) VALUES (?, ?)`)
    .run(userId, badge);
  return r.changes > 0;
}

/**
 * F3: avalia e concede badges automáticas após eventos de pontuação.
 * Idempotente (PK user+badge). Badge "coletânea mais usada da semana" fica
 * pro job semanal (fora do escopo das rotas transacionais).
 */
export function evaluateBadges(db: DbLike, userId: number): string[] {
  const granted: string[] = [];

  const publishes = db
    .prepare(
      `SELECT COUNT(DISTINCT ref_id) AS n FROM contrib_points WHERE user_id = ? AND reason = 'publish'`,
    )
    .get(userId) as { n: number };

  if (publishes.n >= 1 && grantBadge(db, userId, "first_public")) {
    granted.push("first_public");
  }
  if (publishes.n >= 10 && grantBadge(db, userId, "ten_publics")) {
    granted.push("ten_publics");
  }

  const uses = db
    .prepare(
      `SELECT COUNT(*) AS n FROM collection_uses cu
       JOIN custom_collections cc ON cc.id_collection = cu.collection_id
       WHERE cc.owner_id = ?`,
    )
    .get(userId) as { n: number };
  if (uses.n >= 100 && grantBadge(db, userId, "hundred_uses")) {
    granted.push("hundred_uses");
  }

  return granted;
}

/** Lista badges do usuário (F3: exibição no perfil/ranking). */
export function listUserBadges(db: DbLike, userId: number): string[] {
  return (
    db
      .prepare(
        `SELECT badge FROM user_badges WHERE user_id = ? ORDER BY granted_at`,
      )
      .all(userId) as Array<{ badge: string }>
  ).map((r) => r.badge);
}

/** Níveis (decisão #2: nomes NEUTROS). 0/50/150/400/1000. */
export const LEVELS = [
  { min: 0, name: "Iniciante" },
  { min: 50, name: "Colaborador" },
  { min: 150, name: "Veterano" },
  { min: 400, name: "Mestre" },
  { min: 1000, name: "Lenda" },
] as const;

export function getLevel(totalPoints: number): {
  level: number;
  name: string;
  min: number;
  next: number | null;
} {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalPoints >= LEVELS[i].min) idx = i;
  }
  const current = LEVELS[idx];
  const next = LEVELS[idx + 1];
  return {
    level: idx + 1,
    name: current.name,
    min: current.min,
    next: next ? next.min : null,
  };
}
