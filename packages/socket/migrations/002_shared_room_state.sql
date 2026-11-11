BEGIN;

ALTER TABLE quizzes ADD COLUMN game_mode text NOT NULL DEFAULT 'quiz'
    CHECK (game_mode IN ('quiz', 'survey'));

ALTER TABLE rooms ADD COLUMN locked boolean NOT NULL DEFAULT false;

CREATE TABLE data_imports (
    name text PRIMARY KEY
);

COMMIT;
