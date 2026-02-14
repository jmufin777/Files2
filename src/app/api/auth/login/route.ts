/**
 * POST /api/auth/login
 * Body: { email: string }
 *
 * If user exists & deny=0 → send magic link.
 * If user doesn't exist → send approval request to both approvers.
 */
import { NextResponse } from "next/server";
import {
  findUserByEmail,
  generateToken,
  storeToken,
  magicLinkExpiryMs,
  sendMail,
} from "@/lib/auth";

export const runtime = "nodejs";

function getBaseUrl(request: Request): string {
  const envBase =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";
  if (envBase) {
    return envBase.replace(/\/$/, "");
  }
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

export async function POST(request: Request) {
  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const email = (body.email ?? "").toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Zadejte platný email." }, { status: 400 });
  }

  const baseUrl = getBaseUrl(request);
  const expiryMs = magicLinkExpiryMs();

  try {
    const user = await findUserByEmail(email);

    if (user && user.deny === 0) {
      // ── Approved user → send magic link ────────────────────────────
      const token = generateToken();
      await storeToken(token, email, "magic_link", new Date(Date.now() + expiryMs));

      const link = `${baseUrl}/api/auth/verify?token=${token}`;
      const expiryMin = Math.round(expiryMs / 60000);

      await sendMail(
        email,
        "Přihlášení – Jardovo hledání",
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <h2 style="color:#10b981;">Jardovo hledání</h2>
          <p>Klikněte na tlačítko níže pro přihlášení:</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${link}" style="background:#10b981;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
              Přihlásit se
            </a>
          </p>
          <p style="color:#666;font-size:13px;">
            Platnost odkazu: ${expiryMin} minut.<br/>
            Pokud jste o přihlášení nežádali, tento email ignorujte.
          </p>
        </div>`
      );

      return NextResponse.json({
        ok: true,
        message: "Přihlašovací odkaz byl odeslán na váš email.",
      });
    }

    if (user && user.deny !== 0) {
      // ── Denied user ────────────────────────────────────────────────
      return NextResponse.json({
        ok: false,
        message: "Váš přístup byl zamítnut. Kontaktujte správce.",
      }, { status: 403 });
    }

    // ── Unknown user → request approval ────────────────────────────
    const approverToken = generateToken();
    // Approval tokens expire after 7 days
    const approvalExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await storeToken(approverToken, email, "approval", approvalExpiry);

    const approveLink = `${baseUrl}/api/auth/approve?token=${approverToken}`;

    const approver1 = process.env.EMAIL_SCHVALENI1;
    const approver2 = process.env.EMAIL_SCHVALENI2;

    const approvalHtml = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#f59e0b;">Žádost o přístup – Jardovo hledání</h2>
        <p>Uživatel <strong>${email}</strong> se pokouší přihlásit, ale zatím není schválen.</p>
        <p>Kliknutím na tlačítko schválíte přístup a uživateli bude automaticky odeslán přihlašovací odkaz:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${approveLink}" style="background:#10b981;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
            ✓ Schválit přístup pro ${email}
          </a>
        </p>
        <p style="color:#666;font-size:13px;">
          Platnost schvalovacího odkazu: 7 dní.<br/>
          Pokud uživatele nechcete schválit, tento email ignorujte.
        </p>
      </div>`;

    const emailPromises: Promise<void>[] = [];
    if (approver1) {
      emailPromises.push(
        sendMail(approver1, `Žádost o přístup: ${email}`, approvalHtml)
      );
    }
    if (approver2) {
      emailPromises.push(
        sendMail(approver2, `Žádost o přístup: ${email}`, approvalHtml)
      );
    }

    if (emailPromises.length === 0) {
      return NextResponse.json({
        ok: false,
        message: "Nelze odeslat žádost o schválení — chybí konfigurace schvalovatelů.",
      }, { status: 500 });
    }

    await Promise.all(emailPromises);

    return NextResponse.json({
      ok: true,
      needsApproval: true,
      message:
        "Váš email zatím není schválen. Žádost o schválení byla odeslána správcům. " +
        "Jakmile vás schválí, obdržíte přihlašovací odkaz na email.",
    });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Přihlášení selhalo." },
      { status: 500 }
    );
  }
}
