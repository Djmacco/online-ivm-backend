-- Run ONCE in the Supabase SQL editor after the first `prisma migrate deploy`.
--
-- Supabase exposes every table in the `public` schema through its auto-generated REST/GraphQL API
-- (PostgREST) using the public "anon" key. Our backend connects with a privileged Postgres role
-- (which bypasses RLS), so enabling RLS with NO policies makes every table unreachable through the
-- Supabase API while NestJS keeps working. This enforces "desktop → NestJS → Supabase, never direct".
ALTER TABLE "Business"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordReset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncRecord"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncChange"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RestoreGrant"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessTrial" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PremiumDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- Defence in depth: the financial history must never be rewritten by accident.
-- (Append-only change log: block UPDATE/DELETE on SyncChange.)
CREATE OR REPLACE FUNCTION ims_block_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_change_append_only ON "SyncChange";
CREATE TRIGGER sync_change_append_only BEFORE UPDATE OR DELETE ON "SyncChange"
  FOR EACH ROW EXECUTE FUNCTION ims_block_mutation();

