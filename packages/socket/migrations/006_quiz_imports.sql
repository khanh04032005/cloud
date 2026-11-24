BEGIN;

-- Provenance only: quiz content lives in quizzes/questions, never a second catalog.
CREATE TABLE quiz_imports (
    s3_bucket text NOT NULL,
    s3_key text NOT NULL,
    s3_etag text NOT NULL,
    quiz_id text REFERENCES quizzes (id) ON DELETE SET NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    license text NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (s3_bucket, s3_key, s3_etag)
);

COMMIT;
