/**
 * Shared auth utilities — token generation, email sending, session management.
 */
import { Pool } from "pg";
import { randomBytes, createHash } from "crypto";
import nodemailer from "nodemailer";

// ── Singleton PG pool ──────────────────────────────────────────────────
let _pool: Pool | null = null;
function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

export function authPool(): Pool {
  return getPool();
}

// ── Token helpers ──────────────────────────────────────────────────────
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── Session helpers ────────────────────────────────────────────────────
const SESSION_COOKIE = "nai_session";
const SESSION_MAX_AGE_S = 30 * 24 * 3600; // 30 days

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function sessionMaxAge(): number {
  return SESSION_MAX_AGE_S;
}

export async function createSession(userId: number): Promise<string> {
  const pool = getPool();
  const sessionId = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_S * 1000);
  await pool.query(
    "INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
    [sessionId, userId, expiresAt]
  );
  return sessionId;
}

export async function validateSession(
  sessionId: string | undefined
): Promise<{ userId: number; email: string } | null> {
  if (!sessionId) return null;
  const pool = getPool();
  try {
    const res = await pool.query<{
      user_id: number;
      expires_at: Date;
      email: string;
    }>(
      `SELECT s.user_id, s.expires_at, u.email
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    if (new Date(row.expires_at) < new Date()) {
      // Expired — clean up
      await pool.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
      return null;
    }
    return { userId: row.user_id, email: row.email };
  } catch {
    return null;
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
}

// ── Email transport ────────────────────────────────────────────────────
function createTransport(): nodemailer.Transporter {
  const host = process.env.EMAIL_SERVER_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.EMAIL_SERVER_PORT || "587", 10);
  const user = process.env.EMAIL_SERVER_USER || "";
  const pass = process.env.EMAIL_SERVER_PASSWORD || "";
  const tlsInsecure = process.env.EMAIL_TLS_INSECURE === "true";
  const tlsDisable = process.env.EMAIL_TLS_DISABLE === "true";

  const opts: nodemailer.TransportOptions & {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    tls?: { rejectUnauthorized: boolean };
    ignoreTLS?: boolean;
  } = {
    host,
    port,
    secure: port === 465, // true for 465, STARTTLS for 587
    auth: { user, pass },
  };

  if (tlsInsecure) {
    opts.tls = { rejectUnauthorized: false };
  }
  if (tlsDisable) {
    opts.ignoreTLS = true;
  }

  return nodemailer.createTransport(opts as nodemailer.TransportOptions);
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const from = process.env.EMAIL_FROM || process.env.EMAIL_SERVER_USER || "noreply@example.com";
  const transport = createTransport();
  await transport.sendMail({ from, to, subject, html });
}

// ── Magic link expiration ──────────────────────────────────────────────
export function magicLinkExpiryMs(): number {
  const sec = parseInt(process.env.NEXTLINK_SEC || "3600", 10);
  return (isNaN(sec) || sec <= 0 ? 3600 : sec) * 1000;
}

// ── DB helpers ─────────────────────────────────────────────────────────
export async function findUserByEmail(
  email: string
): Promise<{ id: number; email: string; deny: number; schvaleni1: string | null; schvaleni2: string | null } | null> {
  const pool = getPool();
  const res = await pool.query<{
    id: number;
    email: string;
    deny: number;
    schvaleni1: string | null;
    schvaleni2: string | null;
  }>("SELECT id, email, deny, schvaleni1, schvaleni2 FROM app_users WHERE email = $1", [
    email.toLowerCase().trim(),
  ]);
  return res.rows[0] ?? null;
}

export async function createUser(
  email: string,
  approverEmail: string
): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: number }>(
    "INSERT INTO app_users (email, deny, schvaleni1) VALUES ($1, 0, $2) RETURNING id",
    [email.toLowerCase().trim(), approverEmail.toLowerCase().trim()]
  );
  return res.rows[0].id;
}

export async function setSecondApprover(
  email: string,
  approverEmail: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE app_users SET schvaleni2 = $2, updated_at = NOW() WHERE email = $1",
    [email.toLowerCase().trim(), approverEmail.toLowerCase().trim()]
  );
}

// ── Token DB helpers ───────────────────────────────────────────────────
export async function storeToken(
  token: string,
  email: string,
  type: "magic_link" | "approval",
  expiresAt: Date
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "INSERT INTO auth_tokens (token, email, type, expires_at) VALUES ($1, $2, $3, $4)",
    [token, email.toLowerCase().trim(), type, expiresAt]
  );
}

export async function consumeToken(
  token: string,
  type: "magic_link" | "approval"
): Promise<{ email: string } | null> {
  const pool = getPool();
  const res = await pool.query<{ email: string }>(
    `UPDATE auth_tokens
     SET used = TRUE
     WHERE token = $1 AND type = $2 AND used = FALSE AND expires_at > NOW()
     RETURNING email`,
    [token, type]
  );
  return res.rows[0] ?? null;
}
