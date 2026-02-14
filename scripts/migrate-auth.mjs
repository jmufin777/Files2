/**
 * Migration: Create auth tables (app_users, auth_sessions, auth_tokens)
 *
 * Run:  node scripts/migrate-auth.mjs
 */
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://nai_user:nai_password@localhost:5432/nai_db";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── app_users ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id            SERIAL PRIMARY KEY,
        email         TEXT    NOT NULL UNIQUE,
        deny          INTEGER NOT NULL DEFAULT 0,
        schvaleni1    TEXT,           -- email of first approver (NULL = not yet approved)
        schvaleni2    TEXT,           -- email of second approver
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── auth_sessions ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id            TEXT        PRIMARY KEY,
        user_id       INTEGER     NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── auth_tokens (magic-link + approval tokens) ─────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id            SERIAL  PRIMARY KEY,
        token         TEXT    NOT NULL UNIQUE,
        email         TEXT    NOT NULL,
        type          TEXT    NOT NULL DEFAULT 'magic_link',  -- 'magic_link' | 'approval'
        expires_at    TIMESTAMPTZ NOT NULL,
        used          BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Index for fast token lookup
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_id ON auth_sessions(id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
    `);

    await client.query("COMMIT");
    console.log("✅ Auth migration completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
