import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import PostalMime from "postal-mime";
import { z } from "zod";

const inboxSchema = z.object({
  address: z.string(),
  local_part: z.string(),
});

const messageSchema = z.object({
  id: z.number(),
  envelope_from: z.string(),
  subject: z.string().nullable(),
  received_at: z.number(),
});

const messageDetailSchema = messageSchema.extend({
  body_text: z.string().nullable(),
  body_html: z.string().nullable(),
});

type Inbox = z.infer<typeof inboxSchema>;
type Message = z.infer<typeof messageSchema>;
type MessageDetail = z.infer<typeof messageDetailSchema>;

async function createInbox(env: Env): Promise<Inbox> {
  const localPart = crypto.randomUUID().replace(/-/g, "");

  await env.DB.prepare("insert into inboxes (local_part) values (?)")
    .bind(localPart)
    .run();

  return {
    address: `${localPart}@${env.INBOX_DOMAIN}`,
    local_part: localPart,
  };
}

async function inboxExists(env: Env, localPart: string): Promise<boolean> {
  const inbox = await env.DB.prepare(
    "select local_part from inboxes where local_part = ?",
  )
    .bind(localPart)
    .first();

  return inbox !== null;
}

async function listMessages(
  env: Env,
  localPart: string,
): Promise<Message[] | null> {
  if (!(await inboxExists(env, localPart))) return null;

  const { results } = await env.DB.prepare(
    "select id, envelope_from, subject, received_at from messages where local_part = ? order by id desc limit 100",
  )
    .bind(localPart)
    .all<Message>();

  return results;
}

async function getMessage(
  env: Env,
  localPart: string,
  id: number,
): Promise<MessageDetail | null> {
  return await env.DB.prepare(
    "select id, envelope_from, subject, received_at, body_text, body_html from messages where local_part = ? and id = ?",
  )
    .bind(localPart, id)
    .first<MessageDetail>();
}

function createServer(env: Env) {
  const server = new McpServer({ name: "agent-inbox", version: "1.0.0" });

  server.registerTool(
    "create_inbox",
    {
      description:
        "Create a new inbox. Returns the email address to hand out, and the local_part that identifies it in the other tools.",
      outputSchema: inboxSchema,
    },
    async () => {
      const inbox = await createInbox(env);

      return {
        content: [{ type: "text", text: JSON.stringify(inbox) }],
        structuredContent: inbox,
      };
    },
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "List messages received at an inbox, newest first. Bodies are not included; use get_message for one message. Returns null if no such inbox exists, and an empty array if it exists but has received nothing.",
      inputSchema: z.object({ local_part: z.string() }),
      outputSchema: z.object({
        messages: z.array(messageSchema).nullable(),
      }),
    },
    async ({ local_part }) => {
      const messages = await listMessages(env, local_part);

      return {
        content: [{ type: "text", text: JSON.stringify(messages) }],
        structuredContent: { messages },
      };
    },
  );

  server.registerTool(
    "get_message",
    {
      description:
        "Get one message, including its body. The id comes from list_messages. Returns null if there is no such message.",
      inputSchema: z.object({ local_part: z.string(), id: z.number() }),
      outputSchema: z.object({ message: messageDetailSchema.nullable() }),
    },
    async ({ local_part, id }) => {
      const message = await getMessage(env, local_part, id);

      return {
        content: [{ type: "text", text: JSON.stringify(message) }],
        structuredContent: { message },
      };
    },
  );

  return server;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/inboxes") {
      return Response.json(await createInbox(env), { status: 201 });
    }

    const listMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/messages$/);

    if (request.method === "GET" && listMatch) {
      const messages = await listMessages(env, listMatch[1]);

      return messages
        ? Response.json(messages)
        : new Response("Not found", { status: 404 });
    }

    const getMatch = url.pathname.match(
      /^\/inboxes\/([^/]+)\/messages\/(\d+)$/,
    );

    if (request.method === "GET" && getMatch) {
      const message = await getMessage(env, getMatch[1], Number(getMatch[2]));

      return message
        ? Response.json(message)
        : new Response("Not found", { status: 404 });
    }

    return new Response("ok");
  },

  async email(message, env): Promise<void> {
    const to = message.to.toLowerCase();
    const suffix = `@${env.INBOX_DOMAIN}`;

    if (!to.endsWith(suffix)) {
      message.setReject("Unknown address");
      return;
    }

    const localPart = to.slice(0, -suffix.length);

    if (!(await inboxExists(env, localPart))) {
      message.setReject("Unknown address");
      return;
    }

    const parsed = await PostalMime.parse(message.raw).catch(() => null);

    await env.DB.prepare(
      "insert into messages (local_part, envelope_from, subject, received_at, body_text, body_html) values (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        localPart,
        message.from,
        parsed?.subject ?? message.headers.get("subject"),
        Math.floor(Date.now() / 1000),
        parsed?.text ?? null,
        parsed?.html ?? null,
      )
      .run();
  },
} satisfies ExportedHandler<Env>;
