BEGIN;

ALTER TABLE rooms ADD COLUMN owner_token text;
ALTER TABLE rooms ADD COLUMN owner_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN lease_until timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE rooms ADD COLUMN manager_socket_id text NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN manager_connected boolean NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN host_state jsonb;
ALTER TABLE rooms ADD COLUMN host_state_position integer NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN stage_deadline timestamptz;
ALTER TABLE rooms ADD COLUMN auto_advance_at timestamptz;
ALTER TABLE rounds ADD COLUMN closed_at timestamptz;

CREATE INDEX rooms_recovery_idx ON rooms (lease_until)
    WHERE status IN ('lobby', 'running');

COMMIT;
