-- Keep the newest primary membership for any contact that already has duplicates.
WITH ranked_primary_memberships AS (
  SELECT
    "workspace_id",
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspace_id", "contact_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS "primary_rank"
  FROM "contact_board_memberships"
  WHERE "is_primary" = true
)
UPDATE "contact_board_memberships" AS "membership"
SET "is_primary" = false
FROM "ranked_primary_memberships" AS "ranked"
WHERE
  "membership"."workspace_id" = "ranked"."workspace_id"
  AND "membership"."id" = "ranked"."id"
  AND "ranked"."primary_rank" > 1;

CREATE UNIQUE INDEX "contact_board_memberships_one_primary_per_contact"
ON "contact_board_memberships" ("workspace_id", "contact_id")
WHERE "is_primary" = true;
