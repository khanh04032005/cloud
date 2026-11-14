BEGIN;

ALTER TABLE rooms ADD COLUMN runtime jsonb;
ALTER TABLE rooms ADD COLUMN current_position integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN game_mode text NOT NULL DEFAULT 'quiz' CHECK (game_mode IN ('quiz', 'survey'));
UPDATE rooms SET game_mode = quizzes.game_mode FROM quizzes WHERE rooms.quiz_id = quizzes.id;
ALTER TABLE players ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE players ADD COLUMN connected boolean NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN socket_id text NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN state jsonb;
ALTER TABLE players ADD COLUMN state_position integer NOT NULL DEFAULT 0;

ALTER TABLE answers ALTER COLUMN choice DROP NOT NULL;
ALTER TABLE answers ADD COLUMN answer_keys jsonb;
UPDATE answers SET answer_keys = jsonb_build_array(choice);
ALTER TABLE answers ALTER COLUMN answer_keys SET NOT NULL;
ALTER TABLE answers ADD CONSTRAINT answers_keys_array CHECK (jsonb_typeof(answer_keys) = 'array');

CREATE TABLE game_reports (
    id text PRIMARY KEY,
    room_id uuid NOT NULL UNIQUE REFERENCES rooms (id),
    report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object')
);

COMMIT;
