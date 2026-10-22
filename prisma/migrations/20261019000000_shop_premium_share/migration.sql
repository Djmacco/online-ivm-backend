-- A device may receive shop-wide Premium from one active owner device.
CREATE TABLE "PremiumShare" (
    "ownerDeviceId" TEXT NOT NULL,
    "memberDeviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PremiumShare_pkey" PRIMARY KEY ("memberDeviceId")
);
CREATE INDEX "PremiumShare_ownerDeviceId_idx" ON "PremiumShare"("ownerDeviceId");
