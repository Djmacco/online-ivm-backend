CREATE TYPE "TrialScanStatus" AS ENUM ('AVAILABLE', 'IN_PROGRESS', 'USED');

CREATE TABLE "BusinessTrial" (
    "businessId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "syncStartedAt" TIMESTAMP(3),
    "syncExpiresAt" TIMESTAMP(3),
    "scanStatus" "TrialScanStatus" NOT NULL DEFAULT 'AVAILABLE',
    "scanClaimId" TEXT,
    "scanClaimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessTrial_pkey" PRIMARY KEY ("businessId")
);

CREATE UNIQUE INDEX "BusinessTrial_deviceId_key" ON "BusinessTrial"("deviceId");
CREATE INDEX "BusinessTrial_deviceId_idx" ON "BusinessTrial"("deviceId");
CREATE INDEX "BusinessTrial_syncExpiresAt_idx" ON "BusinessTrial"("syncExpiresAt");

ALTER TABLE "BusinessTrial" ADD CONSTRAINT "BusinessTrial_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
