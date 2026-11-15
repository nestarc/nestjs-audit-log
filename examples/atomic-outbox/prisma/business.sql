CREATE TABLE business_writes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL
);

-- A receiver stores the receipt and its business effect in its own transaction.
-- Keep receipts for the full redelivery/replay window before pruning them.
CREATE TABLE consumer_receipts (
  tenant_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, audit_id)
);
CREATE TABLE consumer_totals (
  tenant_id TEXT PRIMARY KEY,
  handled INTEGER NOT NULL
);
