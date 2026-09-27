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
  farmName: string | null;
}): Promise<boolean> {
  const subject = `${opts.ownerName ?? "Someone"} invited you to Chiguru`;
  const body = [
    `Hi ${opts.inviteeName},`,
    "",
    `${opts.ownerName ?? "An owner"} has invited you to help manage ${opts.farmName ? `their farm "${opts.farmName}"` : "their farm"} on Chiguru.`,
    "",
    "Download the Chiguru app and sign in with this email address to get access:",
    "https://thechiguru.com",
  ].join("\n");

  if (process.env.MAIL_ENABLED !== "true") {
    logger.info({ to: opts.toEmail, subject, body }, "Invite email not sent (MAIL_ENABLED is not set) — logged instead");
    return false;
  }

  // TODO: replace with an actual AWS SES SendEmailCommand once credentials
  // are provisioned for this project.
  logger.warn({ to: opts.toEmail }, "MAIL_ENABLED is true but SES sending is not yet implemented");
  return false;
}
