import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
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

async function listMessages(
  env: Env,
  address: string,
): Promise<z.infer<typeof messageSchema>[]> {
  const localPart = address.split("@")[0].toLowerCase();

  const { results } = await env.DB.prepare(
    "select id, envelope_from, subject, received_at from messages where local_part = ? order by id desc limit 100",
  )
    .bind(localPart)
    .all<z.infer<typeof messageSchema>>();

  return results;
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
      description: "List messages received at an inbox address, newest first.",
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

    const match = url.pathname.match(/^\/inboxes\/([^/]+)\/messages$/);

    if (request.method === "GET" && match) {
      return Response.json(await listMessages(env, match[1]));
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

    await env.DB.prepare(
      "insert into messages (local_part, envelope_from, subject, received_at) values (?, ?, ?, ?)",
    )
      .bind(
        localPart,
        message.from,
        message.headers.get("subject"),
        Math.floor(Date.now() / 1000),
      )
      .run();
  },
} satisfies ExportedHandler<Env>;
