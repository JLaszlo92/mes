-- Work instructions: uploaded PDF files, and an explicit link from a work
-- order to an instruction.
--
-- The PDF is stored in the database (bytea), not on the file system, on
-- purpose: the daily pg_dump and the restore drill then cover it without a
-- second backup path, the transport is the same verified TLS connection, and
-- there is no directory whose owner or mode can be wrong after a reinstall.
-- Identical uploads are stored once (sha256 is unique). If the documents ever
-- grow into gigabytes, move `content` to object storage and keep this table
-- as the index.
--
-- Idempotent (migrate.ts runs every file on every start).

CREATE TABLE IF NOT EXISTS work_instruction_files (
  id           TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL UNIQUE,
  size_bytes   INTEGER NOT NULL,
  content      BYTEA NOT NULL,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A version points at its file; the file name belongs to the version (two
-- versions may share one stored file under different names).
ALTER TABLE work_instructions
  ADD COLUMN IF NOT EXISTS pdf_file_id TEXT REFERENCES work_instruction_files(id) ON DELETE RESTRICT;
ALTER TABLE work_instructions ADD COLUMN IF NOT EXISTS pdf_file_name TEXT;
CREATE INDEX IF NOT EXISTS work_instructions_pdf_file_idx ON work_instructions (pdf_file_id) WHERE pdf_file_id IS NOT NULL;

-- The instruction a work order uses, by the instruction's name
-- (work_instructions.part_name; versions share the name, so there is no single
-- row to reference). NULL = automatic: the instruction named like the part.
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_instruction_name TEXT;
