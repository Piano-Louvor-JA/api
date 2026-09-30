import type { DbLike } from "./ranking.service.js";
/**
 * F4 — Tarefas semanais (SPEC RF-5).
 *
 * 3 tarefas rotativas por semana (definidas por rotação determinística sobre o
 * número da semana ISO). Bônus creditado 1x por usuário×tarefa×semana.
 * Reset: domingo 00:00 UTC-3 (SPEC) — a rotação semanal já provê o reset,
 * o key da semana isola os créditos.
 */

export const WEEKLY_BONUS = 15;

export type WeeklyTaskDef = {
  id: string;
  description: string;
};

/** Pool de tarefas (neutras, bilíngue-ready — decisão #2). */
export const WEEKLY_TASKS: WeeklyTaskDef[] = [
  { id: "publish_theme", description: "Publique uma coletânea pública nova" },
  {
    id: "complete_tracks",
    description: "Complete letra e áudio de 3 faixas suas",
  },
  { id: "use_others", description: "Use coletâneas de 2 pessoas diferentes" },
  {
    id: "add_covers",
    description: "Adicione capa personalizada a 2 coletâneas suas",
  },
];

/** Número da semana ISO (anos começam na semana com 1a quinta-feira). */
export function isoWeekKey(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** As 3 tarefas da semana (rotação determinística). */
export function weeklyTasksFor(weekKey: string): WeeklyTaskDef[] {
  const start = weekKey.split("-W")[1];
  const offset = Number(start) % WEEKLY_TASKS.length;
  return [0, 1, 2].map((i) => WEEKLY_TASKS[(offset + i) % WEEKLY_TASKS.length]);
}

/** Marca tarefa como concluída pelo usuário na semana (idempotente). */
export function completeWeeklyTask(
  db: DbLike,
  userId: number,
  task: WeeklyTaskDef,
  weekKey: string,
): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO weekly_task_completions (user_id, week_key, task_id, bonus) VALUES (?, ?, ?, ?)`,
    )
    .run(userId, weekKey, task.id, WEEKLY_BONUS);
  return r.changes > 0;
}

/** Tarefas da semana + status de conclusão do usuário. */
export function getWeeklyTasksForUser(
  db: DbLike,
  userId: number,
  weekKey: string,
): Array<WeeklyTaskDef & { done: boolean }> {
  const done = new Set(
    (
      db
        .prepare(
          `SELECT task_id FROM weekly_task_completions WHERE user_id = ? AND week_key = ?`,
        )
        .all(userId, weekKey) as Array<{ task_id: string }>
    ).map((r) => r.task_id),
  );
  return weeklyTasksFor(weekKey).map((t) => ({
    ...t,
    done: done.has(t.id),
  }));
}

/** Total de bônus semanais conquistados (soma na semana do usuário). */
export function weeklyBonusEarned(
  db: DbLike,
  userId: number,
  weekKey: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bonus), 0) AS total FROM weekly_task_completions WHERE user_id = ? AND week_key = ?`,
    )
    .get(userId, weekKey) as { total: number };
  return row.total;
}
