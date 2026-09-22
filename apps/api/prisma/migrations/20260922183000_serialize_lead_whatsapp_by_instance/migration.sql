-- Prevent separate API processes from checking two batches against the same
-- Evolution instance concurrently. The scheduler also keeps a local fast-path
-- guard, while this index is the durable cross-process arbiter.
CREATE UNIQUE INDEX "lead_jobs_one_running_whatsapp_per_instance_idx"
ON "lead_jobs" (("input" ->> 'instanceName'))
WHERE "operation" IN ('whatsapp_availability', 'whatsapp_availability_batch')
  AND "status" = 'running'
  AND ("input" ->> 'instanceName') IS NOT NULL;
