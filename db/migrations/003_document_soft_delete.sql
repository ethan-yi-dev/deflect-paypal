ALTER TABLE t_knowledge_document ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Retained documents must not prevent a new upload with the same name.
-- Keep this index name so earlier repeatable migrations do not recreate the
-- original, unconditional uniqueness constraint.
DROP INDEX IF EXISTS knowledge_document_name;
CREATE UNIQUE INDEX knowledge_document_name ON t_knowledge_document (knowledge_base_id, name)
  WHERE deleted_at IS NULL;
