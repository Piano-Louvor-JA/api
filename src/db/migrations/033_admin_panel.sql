-- SPEC piano-admin-panel v1.1.0 (RF-02): pool de tasks semanais sai do
-- hard-code para tabela (gestão via UI admin). Fallback: tabela vazia usa
-- pool default do código (weekly-tasks.service.ts).
CREATE TABLE IF NOT EXISTS weekly_task_defs (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
