"""SQLite schema for route drafts (migration 3), kept apart from drafts.py so
database.py can import it without a cycle."""

DRAFTS_MIGRATION = """
CREATE TABLE route_drafts (
    draft_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('to_school','from_school')),
    status TEXT NOT NULL CHECK (status IN ('recording','finished')),
    driver_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER
);
CREATE TABLE route_draft_points (
    draft_id TEXT NOT NULL REFERENCES route_drafts(draft_id),
    seq INTEGER NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    horizontal_accuracy_m REAL,
    gap_before INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (draft_id, seq)
);
CREATE TABLE route_draft_stops (
    stop_id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES route_drafts(draft_id),
    request_id TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    captured_at_ms INTEGER NOT NULL,
    marked_by_driver_id TEXT NOT NULL
);
CREATE INDEX route_draft_stops_order ON route_draft_stops(draft_id, position);
"""
