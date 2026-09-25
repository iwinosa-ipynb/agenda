import "server-only";

/**
 * Email service abstraction (Stage 10).
 *
 * Design rules (per the Stage 10 brief):
 *  - There is deliberately NO fake/mock sender in production code. When the
 *    provider is not configured, every call FAILS CLOSED: an
 *    `EmailNotConfiguredError` is thrown and nothing is delivered or
 *    pretended to be delivered. Callers surface that as an explicit error.
 *  - The provider choice lives behind `sendEmail` only. The first provider
 *    implementation is Brevo (Sendinblue): a plain HTTPS API call with a
 *    single API key — no SDK dependency, generous free tier, and widely used
 *    by Nigerian startups. Swapping providers later means editing only the
 *    `sendWithBrevo` function and the env vars in .env.example.
 *  - Never log recipient addresses at debug level or message bodies; never
 *    log API keys. Errors are logged with provider status codes only.
 *
 * Environment variables (see .env.example):
 *  - EMAIL_PROVIDER       optional, "brevo" (only provider for now)
 *  - BREVO_API_KEY        required when EMAIL_PROVIDER=brevo
 *  - EMAIL_FROM_ADDRESS   sender address, must be a validated sender in Brevo
 *  - EMAIL_FROM_NAME      optional display name (defaults to "Agenda")
 *  - APP_BASE_URL         used to build verification links
 */

export type EmailNotConfiguredReason =
  | "no_provider"
  | "missing_api_key"
  | "missing_from_address";

/** Thrown when email sending is attempted without a configured provider. */
export class EmailNotConfiguredError extends Error {
  readonly reason: EmailNotConfiguredReason;

  constructor(reason: EmailNotConfiguredReason) {
    super(reasonToMessage(reason));
    this.name = "EmailNotConfiguredError";
    this.reason = reason;
  }
}

function reasonToMessage(reason: EmailNotConfiguredReason): string {
  switch (reason) {
    case "no_provider":
      return "EMAIL_PROVIDER is not configured on this server.";
    case "missing_api_key":
      return "The email provider API key is missing on this server.";
    case "missing_from_address":
      return "EMAIL_FROM_ADDRESS is not configured on this server.";
  }
}

/** Thrown when the provider rejects a send (non-2xx) or is unreachable. */
export class EmailDeliveryError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmailDeliveryError";
    this.status = status;
  }
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type EmailSendResult = {
  /** Provider message id when the provider returns one; null otherwise. */
  providerMessageId: string | null;
};

/** Resolves the provider name. Null/empty/unknown = unconfigured. */
export function resolveEmailProvider(
  provider: string | undefined,
): "brevo" | null {
  const normalized = provider?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  return normalized === "brevo" ? "brevo" : null;
}

/**
 * Check configuration WITHOUT sending. Used to give operators a fast,
 * explicit signal (e.g. at registration time) that email cannot be delivered.
 */
export function isEmailConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const provider = resolveEmailProvider(env.EMAIL_PROVIDER);

  if (provider !== "brevo") {
    return false;
  }

  return Boolean(env.BREVO_API_KEY?.trim()) && Boolean(env.EMAIL_FROM_ADDRESS?.trim());
}

function configurationError(
  env: NodeJS.ProcessEnv,
): EmailNotConfiguredError | null {
  if (resolveEmailProvider(env.EMAIL_PROVIDER) !== "brevo") {
    return new EmailNotConfiguredError("no_provider");
  }

  if (!env.BREVO_API_KEY?.trim()) {
    return new EmailNotConfiguredError("missing_api_key");
  }

  if (!env.EMAIL_FROM_ADDRESS?.trim()) {
    return new EmailNotConfiguredError("missing_from_address");
  }

  return null;
}

/**
 * Send an email through the configured provider. Fails closed when
 * unconfigured; throws EmailDeliveryError on provider rejection.
 */
export async function sendEmail(email: OutgoingEmail): Promise<EmailSendResult> {
  const notConfigured = configurationError(process.env);

  if (notConfigured) {
    throw notConfigured;
  }

  return sendWithBrevo(email);
}

/**
 * Brevo transactional email — POST /v3/smtp/email.
 * API key comes from BREVO_API_KEY. The response is minimal on purpose:
 * we keep only the provider message id. Keys and bodies are never logged.
 */
async function sendWithBrevo(email: OutgoingEmail): Promise<EmailSendResult> {
  const apiKey = process.env.BREVO_API_KEY!.trim();
  const fromAddress = process.env.EMAIL_FROM_ADDRESS!.trim();
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || "Agenda";

  let response: Response;

  try {
    response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: fromAddress, name: fromName },
        to: [{ email: email.to }],
        subject: email.subject,
        textContent: email.text,
        htmlContent: email.html,
      }),
    });
  } catch {
    // Network-level failure. Never include the key or body in errors.
    throw new EmailDeliveryError("Email provider is unreachable.");
  }

  if (!response.ok) {
    // Log only the status — never the payload (it can echo addresses).
    console.error("email send failed with provider status", response.status);
    throw new EmailDeliveryError(
      "Email provider rejected the message.",
      response.status,
    );
  }

  let messageId: string | null = null;

  try {
    const payload = (await response.json()) as { messageId?: unknown };
    messageId = typeof payload.messageId === "string" ? payload.messageId : null;
  } catch {
    // Body parsing must never fail the send — a 2xx means accepted.
  }

  return { providerMessageId: messageId };
}
