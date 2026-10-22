-- Attempts are now executed by the initiating HTTP request. Keep this table as
-- processing history, with durable progress rather than a consumable queue.
ALTER TABLE t_knowledge_job ADD COLUMN IF NOT EXISTS stage text
  CHECK (stage IN ('load', 'parse', 'chunk', 'embed', 'store'));
ALTER TABLE t_knowledge_job ADD COLUMN IF NOT EXISTS completed_chunks integer NOT NULL DEFAULT 0
  CHECK (completed_chunks >= 0);
ALTER TABLE t_knowledge_job ADD COLUMN IF NOT EXISTS total_chunks integer NOT NULL DEFAULT 0
  CHECK (total_chunks >= completed_chunks);
