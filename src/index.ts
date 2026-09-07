import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import PostalMime from "postal-mime";
import { z } from "zod";

async function createInbox(env: Env): Promise<string> {
  const localPart = crypto.randomUUID().replace(/-/g, "");

  await env.DB.prepare("insert into inboxes (local_part) values (?)")
    .bind(localPart)
    .run();

  return `${localPart}@${env.INBOX_DOMAIN}`;
}

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

type Message = z.infer<typeof messageSchema>;
type MessageDetail = z.infer<typeof messageDetailSchema>;

function localPartOf(address: string): string {
  return address.split("@")[0].toLowerCase();
}

async function listMessages(env: Env, address: string): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    "select id, envelope_from, subject, received_at from messages where local_part = ? order by id desc limit 100",
  )
    .bind(localPartOf(address))
    .all<Message>();

  return results;
}

async function getMessage(
  env: Env,
  address: string,
  id: number,
): Promise<MessageDetail | null> {
  return await env.DB.prepare(
    "select id, envelope_from, subject, received_at, body_text, body_html from messages where local_part = ? and id = ?",
  )
    .bind(localPartOf(address), id)
    .first<MessageDetail>();
}

function createServer(env: Env) {
  const server = new McpServer({ name: "agent-inbox", version: "1.0.0" });

  server.registerTool(
    "create_inbox",
    {
      description: "Create a new inbox and return the email address to use.",
      outputSchema: z.object({ address: z.string() }),
    },
    async () => {
      const address = await createInbox(env);

      return {
        content: [{ type: "text", text: address }],
        structuredContent: { address },
      };
    },
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "List messages received at an inbox address, newest first. Bodies are not included; use get_message for one message.",
      inputSchema: z.object({ address: z.string() }),
      outputSchema: z.object({ messages: z.array(messageSchema) }),
    },
    async ({ address }) => {
      const messages = await listMessages(env, address);

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
        "Get one message received at an inbox address, including its body. The id comes from list_messages.",
      inputSchema: z.object({ address: z.string(), id: z.number() }),
      outputSchema: z.object({ message: messageDetailSchema.nullable() }),
    },
    async ({ address, id }) => {
      const message = await getMessage(env, address, id);

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
      return Response.json(
        { address: await createInbox(env) },
        { status: 201 },
      );
    }

    const listMatch = url.pathname.match(/^\/inboxes\/([^/]+)\/messages$/);

    if (request.method === "GET" && listMatch) {
      return Response.json(await listMessages(env, listMatch[1]));
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

    const inbox = await env.DB.prepare(
      "select local_part from inboxes where local_part = ?",
    )
      .bind(localPart)
      .first();

    if (!inbox) {
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
