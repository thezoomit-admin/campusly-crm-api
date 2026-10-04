import { config } from "../../config";
import {
  EmailProviderError,
  isEmailMockMode,
  sendMailboxEmail,
} from "../email/email.client";

export type AuthMailLinkKind = "invite" | "reset";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAuthActionPath(token: string, kind: AuthMailLinkKind) {
  const query =
    kind === "invite" ? `token=${token}&invite=1` : `token=${token}`;
  return `/reset-password?${query}`;
}

export function buildAuthActionUrl(token: string, kind: AuthMailLinkKind) {
  return `${config.appPublicUrl}${buildAuthActionPath(token, kind)}`;
}

export async function sendAuthActionEmail(input: {
  to: string;
  fullName: string;
  token: string;
  kind: AuthMailLinkKind;
  expiresHours: number;
}) {
  const actionUrl = buildAuthActionUrl(input.token, input.kind);
  const safeName = escapeHtml(input.fullName || "there");
  const brand = config.email.fromName || "Campusly";
  const isInvite = input.kind === "invite";

  const subject = isInvite
    ? `Set up your ${brand} account`
    : `Reset your ${brand} password`;

  const intro = isInvite
    ? `An account was created for you on ${brand}. Use the securelink below to choose your password and activate access.`
    : `We received a request to reset the password for your ${brand} account.`;

  const cta = isInvite ? "Set password" : "Reset password";
  const expiryNote = `This link expires in ${input.expiresHours} hour${input.expiresHours === 1 ? "" : "s"} and can be used only once.`;

  const text = [
    `Hi ${input.fullName || "there"},`,
    "",
    intro,
    "",
    `${cta}: ${actionUrl}`,
    "",
    expiryNote,
    "",
    "If you did not expect this email, you can ignore it.",
    "",
    `— ${brand}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;">
            <tr>
              <td>
                <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">${escapeHtml(brand)}</p>
                <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;">${isInvite ? "Set up your account" : "Reset your password"}</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">Hi ${safeName},</p>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>
                <p style="margin:0 0 24px;">
                  <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:8px;">${cta}</a>
                </p>
                <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563;">${escapeHtml(expiryNote)}</p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;word-break:break-all;">If the button does not work, open this link:<br/>${escapeHtml(actionUrl)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  try {
    await sendMailboxEmail({
      to: input.to,
      subject,
      text,
      html,
    });
  } catch (error) {
    if (error instanceof EmailProviderError) {
      throw error;
    }
    throw new EmailProviderError(
      error instanceof Error ? error.message : "Unable to send email.",
    );
  }

  return {
    actionUrl,
    actionPath: buildAuthActionPath(input.token, input.kind),
    mocked: isEmailMockMode(),
  };
}
