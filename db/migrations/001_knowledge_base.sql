CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS t_knowledge_base (
  id text PRIMARY KEY,
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions BETWEEN 1 AND 3072),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, embedding_model, embedding_dimensions)
);

CREATE OR REPLACE FUNCTION prevent_knowledge_model_change() RETURNS trigger AS $$
BEGIN
  IF NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.embedding_dimensions IS DISTINCT FROM OLD.embedding_dimensions THEN
    RAISE EXCEPTION 'Embedding model and dimensions are immutable; create a new knowledge base and reindex.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_model_immutable ON t_knowledge_base;
CREATE TRIGGER knowledge_model_immutable BEFORE UPDATE ON t_knowledge_base
  FOR EACH ROW EXECUTE FUNCTION prevent_knowledge_model_change();

CREATE TABLE IF NOT EXISTS t_knowledge_document (
  id uuid PRIMARY KEY,
  knowledge_base_id text NOT NULL,
  name text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 52428800),
  content_type text NOT NULL DEFAULT 'application/pdf' CHECK (content_type = 'application/pdf'),
  pdf_data bytea NOT NULL CHECK (octet_length(pdf_data) = size),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed')),
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  active_run_id uuid,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  CHECK ((status = 'running') = (active_run_id IS NOT NULL)),
  UNIQUE (id, knowledge_base_id, embedding_model, embedding_dimensions),
  FOREIGN KEY (knowledge_base_id, embedding_model, embedding_dimensions)
    REFERENCES t_knowledge_base (id, embedding_model, embedding_dimensions)
);
CREATE INDEX IF NOT EXISTS knowledge_document_list ON t_knowledge_document (knowledge_base_id, created_at DESC);

CREATE TABLE IF NOT EXISTS t_knowledge_chunk (
  id uuid PRIMARY KEY,
  doc_id uuid NOT NULL,
  knowledge_base_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  page_number integer NOT NULL CHECK (page_number > 0),
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  embedding vector NOT NULL CHECK (vector_dims(embedding) = embedding_dimensions),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, chunk_index),
  FOREIGN KEY (doc_id, knowledge_base_id, embedding_model, embedding_dimensions)
    REFERENCES t_knowledge_document (id, knowledge_base_id, embedding_model, embedding_dimensions) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunk_base ON t_knowledge_chunk (knowledge_base_id, embedding_model, embedding_dimensions);
-- The default 768-dimensional binding has an HNSW cosine index. Other dimensions
-- remain searchable with exact pgvector distance; add a matching partial index as needed.
CREATE INDEX IF NOT EXISTS knowledge_chunk_vector_768 ON t_knowledge_chunk
  USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE embedding_dimensions = 768;

CREATE TABLE IF NOT EXISTS t_knowledge_job (
  id uuid PRIMARY KEY,
  doc_id uuid NOT NULL REFERENCES t_knowledge_document (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'working', 'done', 'failed')),
  lease_until timestamptz,
  error_message text,
  failed_step text,
  error_stack text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((state = 'working') = (lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_job_one_active ON t_knowledge_job (doc_id) WHERE state IN ('queued', 'working');
CREATE INDEX IF NOT EXISTS knowledge_job_queue ON t_knowledge_job (created_at) WHERE state = 'queued';
