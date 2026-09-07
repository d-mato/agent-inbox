import PostalMime from "postal-mime";
import { addMessage, inboxIsLive } from "./inbox";

type IncomingEmail = Pick<
  ForwardableEmailMessage,
  "to" | "from" | "raw" | "headers"
>;

/** Stores an incoming email, or returns false if no live inbox accepts it. */
export async function deliverEmail(
  env: Env,
  email: IncomingEmail,
): Promise<boolean> {
  const to = email.to.toLowerCase();
  const suffix = `@${env.INBOX_DOMAIN}`;

  if (!to.endsWith(suffix)) return false;

  const localPart = to.slice(0, -suffix.length);

  if (!(await inboxIsLive(env, localPart))) return false;

  const parsed = await PostalMime.parse(email.raw).catch(() => null);

  await addMessage(env, localPart, {
    envelope_from: email.from,
    subject: parsed?.subject ?? email.headers.get("subject"),
    body_text: parsed?.text ?? null,
    body_html: parsed?.html ?? null,
  });

  return true;
}
