import { z } from "zod";

const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

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
): Promise<Message[] | null> {
  if (!(await inboxIsLive(env, localPart))) return null;

  const { results } = await env.DB.prepare(
    "select id, envelope_from, subject, received_at from messages where local_part = ? order by id desc limit 100",
  )
    .bind(localPart)
    .all<Message>();

  return results;
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
