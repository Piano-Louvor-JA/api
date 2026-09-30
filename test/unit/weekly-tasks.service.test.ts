import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb, initDb } from "../../src/db/connection.js";
import {
  completeWeeklyTask,
  getWeeklyTasksForUser,
  isoWeekKey,
  WEEKLY_BONUS,
  WEEKLY_TASKS,
  weeklyBonusEarned,
  weeklyTasksFor,
} from "../../src/v1/custom/weekly-tasks.service.js";

describe("weekly-tasks.service (F4)", () => {
  let db: ReturnType<typeof getDb>;
  let userId: number;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";
    await initDb();
    db = getDb();
    userId = Number(
      db
        .prepare(
          `INSERT INTO custom_users (email, password_hash, display_name) VALUES ('t@test.local', 'x', 'Tarefa')`,
        )
        .run().lastInsertRowid,
    );
  });
  afterAll(() => closeDb());

  it("isoWeekKey gera chave ano-Wsemana determinística", () => {
    const key = isoWeekKey(new Date("2026-09-16T12:00:00Z"));
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
    expect(key).toBe(isoWeekKey(new Date("2026-09-16T12:00:00Z")));
  });

  it("rotação: 3 tarefas por semana, determinísticas por weekKey", () => {
    const t1 = weeklyTasksFor("2026-W37");
    const t1again = weeklyTasksFor("2026-W37");
    expect(t1).toHaveLength(3);
    expect(t1).toEqual(t1again);
    // semanas diferentes podem ter rotações diferentes
    const ids = new Set(t1.map((t) => t.id));
    expect(ids.size).toBe(3);
    // todas do pool
    for (const t of t1) {
      expect(WEEKLY_TASKS.some((p) => p.id === t.id)).toBe(true);
    }
  });

  it("completar tarefa credita bônus 1x por semana (reset = nova weekKey)", () => {
    const week = isoWeekKey();
    const task = weeklyTasksFor(week)[0];
    expect(completeWeeklyTask(db, userId, task, week)).toBe(true);
    expect(completeWeeklyTask(db, userId, task, week)).toBe(false);
    expect(weeklyBonusEarned(db, userId, week)).toBe(WEEKLY_BONUS);
    // semana seguinte: mesma tarefa pode ser completada de novo (reset)
    const nextWeek = "2099-W01";
    expect(completeWeeklyTask(db, userId, task, nextWeek)).toBe(true);
    expect(weeklyBonusEarned(db, userId, nextWeek)).toBe(WEEKLY_BONUS);
  });

  it("getWeeklyTasksForUser reflete done por semana", () => {
    const week = isoWeekKey();
    const tasks = getWeeklyTasksForUser(db, userId, week);
    expect(tasks).toHaveLength(3);
    const done = tasks.filter((t) => t.done);
    expect(done).toHaveLength(1);
  });
});
