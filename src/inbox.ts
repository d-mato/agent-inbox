import { z } from "zod";

const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
const POLL_INTERVAL_MS = 5000;

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export const inboxSchema = z.object({
  address: z.string(),
  local_part: z.string(),
  expires_at: z.number(),
});

export const messageSchema = z.object({
  id: z.number(),
  envelope_from: z.string(),
  subject: z.string().nullable(),
  received_at: z.number(),
});

export const messageDetailSchema = messageSchema.extend({
  body_text: z.string().nullable(),
  body_html: z.string().nullable(),
});

export type Inbox = z.infer<typeof inboxSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageDetail = z.infer<typeof messageDetailSchema>;

export async function createInbox(env: Env): Promise<Inbox> {
  const localPart = crypto.randomUUID().replace(/-/g, "");
  const createdAt = unixNow();
  const expiresAt = createdAt + INBOX_TTL_SECONDS;

  await env.DB.prepare(
    "insert into inboxes (local_part, created_at, expires_at) values (?, ?, ?)",
  )
    .bind(localPart, createdAt, expiresAt)
    .run();

  return {
    address: `${localPart}@${env.INBOX_DOMAIN}`,
    local_part: localPart,
    expires_at: expiresAt,
  };
}

export async function inboxIsLive(
  env: Env,
  localPart: string,
): Promise<boolean> {
  const inbox = await env.DB.prepare(
    "select local_part from inboxes where local_part = ? and expires_at > ?",
  )
    .bind(localPart, unixNow())
    .first();

  return inbox !== null;
}

export async function listMessages(
  env: Env,
  localPart: string,
  sinceId = 0,
): Promise<Message[] | null> {
  if (!(await inboxIsLive(env, localPart))) return null;

  const { results } = await env.DB.prepare(
    "select id, envelope_from, subject, received_at from messages where local_part = ? and id > ? order by id desc limit 100",
  )
    .bind(localPart, sinceId)
    .all<Message>();

  return results;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Polls until a message newer than `sinceId` arrives. Returns an empty array
 * if the deadline passes first, or null if the inbox does not exist.
 */
export async function waitForMessages(
  env: Env,
  localPart: string,
  sinceId: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Message[] | null> {
  const deadline = Date.now() + timeoutMs;

  while (!signal?.aborted) {
    const messages = await listMessages(env, localPart, sinceId);

    if (messages === null || messages.length > 0) return messages;

    const remaining = deadline - Date.now();

    if (remaining <= 0) return [];

    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }

  return [];
}

export async function getMessage(
  env: Env,
  localPart: string,
  id: number,
): Promise<MessageDetail | null> {
  if (!(await inboxIsLive(env, localPart))) return null;

  return await env.DB.prepare(
    "select id, envelope_from, subject, received_at, body_text, body_html from messages where local_part = ? and id = ?",
  )
    .bind(localPart, id)
    .first<MessageDetail>();
}

export async function addMessage(
  env: Env,
  localPart: string,
  message: Omit<MessageDetail, "id" | "received_at">,
): Promise<void> {
  await env.DB.prepare(
    "insert into messages (local_part, envelope_from, subject, received_at, body_text, body_html) values (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      localPart,
      message.envelope_from,
      message.subject,
      unixNow(),
      message.body_text,
      message.body_html,
    )
    .run();
}

export async function deleteExpiredInboxes(env: Env): Promise<void> {
  await env.DB.prepare("delete from inboxes where expires_at <= ?")
    .bind(unixNow())
    .run();
}
