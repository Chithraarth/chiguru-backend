import { google } from "googleapis";

// Gmail connector client (Replit connector: google-mail).
// The owner connects their Gmail at publish time; until then every helper
// here fails softly so suggestions are never lost — they always stay in the DB.

let connectionSettings: any;

function extractToken(cs: any): string | undefined {
  return (
    cs?.settings?.access_token ?? cs?.settings?.oauth?.credentials?.access_token
  );
}

async function getAccessToken(): Promise<string> {
  const cachedToken = extractToken(connectionSettings);
  if (
    cachedToken &&
    connectionSettings?.settings?.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
  ) {
    return cachedToken;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error("Gmail connector environment not available");
  }

  const response = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-mail`,
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Connector API error (HTTP ${response.status})`);
  }
  const data = (await response.json()) as { items?: any[] };
  connectionSettings = Array.isArray(data.items) ? data.items[0] : undefined;

  const accessToken = extractToken(connectionSettings);
  if (!connectionSettings || !accessToken) {
    throw new Error("Gmail not connected");
  }
  return accessToken;
}

async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * Email a new farmer suggestion to the app owner's own Gmail inbox
 * (sends from the connected account to itself). Never throws — returns
 * false when Gmail is not connected yet or sending fails.
 */
export async function sendSuggestionEmail(opts: {
  farmName: string | null;
  message: string;
  phone: string | null;
  createdAt: Date;
}): Promise<boolean> {
  try {
    const gmail = await getUncachableGmailClient();
    const profile = await gmail.users.getProfile({ userId: "me" });
    const to = profile.data.emailAddress;
    if (!to) throw new Error("Could not resolve Gmail address");

    const subject = `Chiguru suggestion${opts.farmName ? ` — ${opts.farmName}` : ""}`;
    const bodyLines = [
      "A farmer sent a new suggestion in the Chiguru app:",
      "",
      opts.message,
      "",
      "—",
      opts.farmName ? `Farm: ${opts.farmName}` : null,
      opts.phone ? `Phone (for call back): ${opts.phone}` : "Phone: not provided",
      `Sent: ${opts.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
      "",
      "Reply to the farmer from the Helpline admin — your reply appears in their app.",
    ].filter((l): l is string => l !== null);

    const raw = Buffer.from(
      [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        bodyLines.join("\n"),
      ].join("\r\n"),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return true;
  } catch (err) {
    console.warn(
      "Suggestion email not sent (Gmail not connected yet or send failed):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
