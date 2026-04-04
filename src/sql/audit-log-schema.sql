-- @nestarc/audit-log: Audit log table and append-only rules
-- Run this migration in your PostgreSQL database.

CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user',
  actor_ip      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  changes       JSONB,
  metadata      JSONB,
  result        TEXT NOT NULL DEFAULT 'success',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement (SOC2 compliance)
DO $$ BEGIN
  CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Query performance indexes
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action);
