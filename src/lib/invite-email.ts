import { logger } from "./logger";

/**
 * Sends an invite email to someone an Owner has added by email (see
 * routes/managers.ts). Placeholder until AWS SES is provisioned for this
 * project — logs the email instead of sending it, so the rest of the invite
 * flow can be built and tested end-to-end before SES credentials exist.
 *
 * Swap this body for an SES SendEmail call once AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_REGION / MAIL_FROM are set — the function
 * signature and call sites don't need to change.
 */
export async function sendInviteEmail(opts: {
  toEmail: string;
  inviteeName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  farmName: string | null;
}): Promise<boolean> {
  const subject = `${opts.ownerName ?? "Someone"} invited you to Chiguru`;
  const body = [
    `Hi ${opts.inviteeName},`,
    "",
    `${opts.ownerName ?? "An owner"} (${opts.ownerEmail ?? "no email on file"}) has invited you to help manage ${opts.farmName ? `their farm "${opts.farmName}"` : "their farm"} on Chiguru.`,
    "",
    "Open the Chiguru app and sign in with this same email address — you'll see a prompt to accept or decline this invite before it gives you any access.",
    "https://thechiguru.com",
  ].join("\n");

  if (process.env.MAIL_ENABLED !== "true") {
    logger.info({ to: opts.toEmail, subject, body }, "Invite email not sent (MAIL_ENABLED is not set) — logged instead");
    return false;
  }

  // TODO: replace with an actual AWS SES SendEmailCommand once credentials
  // are provisioned for this project. Sent from a system address (MAIL_FROM),
  // never the Owner's own address — SES can't send arbitrary "From" domains
  // without each Owner individually verifying their address, so the Owner is
  // named in the subject/body instead, with reply-to set to their address so
  // a reply still reaches them directly.
  logger.warn({ to: opts.toEmail, replyTo: opts.ownerEmail }, "MAIL_ENABLED is true but SES sending is not yet implemented");
  return false;
}
