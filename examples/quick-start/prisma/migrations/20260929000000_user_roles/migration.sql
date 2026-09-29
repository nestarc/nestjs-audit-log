ALTER TABLE "users" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'demo-tenant',
                    ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';
