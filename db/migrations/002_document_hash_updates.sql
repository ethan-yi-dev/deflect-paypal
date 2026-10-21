ALTER TABLE t_knowledge_document ADD COLUMN IF NOT EXISTS text_content text;
ALTER TABLE t_knowledge_document ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE t_knowledge_document ADD COLUMN IF NOT EXISTS source_version integer NOT NULL DEFAULT 1;
ALTER TABLE t_knowledge_document ALTER COLUMN pdf_data DROP NOT NULL;

UPDATE t_knowledge_document
SET content_hash = encode(sha256(COALESCE(pdf_data, convert_to(text_content, 'UTF8'))), 'hex')
WHERE content_hash IS NULL;
ALTER TABLE t_knowledge_document ALTER COLUMN content_hash SET NOT NULL;

ALTER TABLE t_knowledge_document DROP CONSTRAINT IF EXISTS t_knowledge_document_content_type_check;
ALTER TABLE t_knowledge_document ADD CONSTRAINT t_knowledge_document_content_type_check
  CHECK (content_type IN ('application/pdf', 'text/plain', 'text/markdown'));
ALTER TABLE t_knowledge_document DROP CONSTRAINT IF EXISTS knowledge_document_source;
ALTER TABLE t_knowledge_document ADD CONSTRAINT knowledge_document_source CHECK (
  (content_type = 'application/pdf' AND pdf_data IS NOT NULL AND text_content IS NULL AND octet_length(pdf_data) = size)
  OR (content_type IN ('text/plain', 'text/markdown') AND pdf_data IS NULL AND text_content IS NOT NULL AND octet_length(text_content) = size)
);
ALTER TABLE t_knowledge_document DROP CONSTRAINT IF EXISTS knowledge_document_hash;
ALTER TABLE t_knowledge_document ADD CONSTRAINT knowledge_document_hash CHECK (
  content_hash ~ '^[a-f0-9]{64}$'
  AND content_hash = encode(sha256(COALESCE(pdf_data, convert_to(text_content, 'UTF8'))), 'hex')
);
ALTER TABLE t_knowledge_document DROP CONSTRAINT IF EXISTS knowledge_document_version;
ALTER TABLE t_knowledge_document ADD CONSTRAINT knowledge_document_version CHECK (source_version > 0);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_name ON t_knowledge_document (knowledge_base_id, name);

ALTER TABLE t_knowledge_job ADD COLUMN IF NOT EXISTS source_hash text;
UPDATE t_knowledge_job j SET source_hash=d.content_hash
FROM t_knowledge_document d WHERE d.id=j.doc_id AND j.source_hash IS NULL;
ALTER TABLE t_knowledge_job ALTER COLUMN source_hash SET NOT NULL;
