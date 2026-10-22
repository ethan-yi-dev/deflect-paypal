-- Record outcome and payload hashes, never attachment contents or merchant notes.
CREATE TABLE IF NOT EXISTS t_evidence_submission (
  id uuid PRIMARY KEY,
  merchant_scope text NOT NULL,
  dispute_id text NOT NULL,
  case_hash text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'submitted', 'rejected', 'unknown')),
  receipt jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'submitted') = (receipt IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_submission_same_payload
  ON t_evidence_submission (merchant_scope, dispute_id, case_hash, payload_hash)
  WHERE state <> 'rejected';
CREATE UNIQUE INDEX IF NOT EXISTS evidence_submission_one_active
  ON t_evidence_submission (merchant_scope, dispute_id)
  WHERE state IN ('pending', 'unknown');
