export function installServerSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_catalog(
      host TEXT PRIMARY KEY,label TEXT NOT NULL,hosting TEXT NOT NULL DEFAULT 'unknown',note TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),cpu_model TEXT NOT NULL DEFAULT '',cpu_cores INTEGER,memory_gib REAL,storage_gib REAL,
      version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,updated_by TEXT REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS resource_specs(resource_id TEXT PRIMARY KEY REFERENCES research_resources(id),model TEXT NOT NULL DEFAULT '',memory_gib REAL);
    CREATE TABLE IF NOT EXISTS server_managers(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS server_observations(host TEXT PRIMARY KEY,sample TEXT,last_seen INTEGER,status TEXT NOT NULL DEFAULT 'waiting',candidate_since INTEGER,candidate_sample INTEGER,incident_id INTEGER);
    CREATE TABLE IF NOT EXISTS server_incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,host TEXT NOT NULL,kind TEXT NOT NULL,opened_at INTEGER NOT NULL,resolved_at INTEGER,evidence TEXT NOT NULL,analysis_status TEXT NOT NULL,analysis TEXT);
    CREATE INDEX IF NOT EXISTS server_incidents_time ON server_incidents(opened_at);
  `);
}
