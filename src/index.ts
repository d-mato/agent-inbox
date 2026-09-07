import { createMcpHandler } from "agents/mcp/server";
import { deliverEmail } from "./email";
import {
  createInbox,
  deleteExpiredInboxes,
  getMessage,
  listMessages,
} from "./inbox";
import { createServer } from "./mcp";

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
    if (!(await deliverEmail(env, message))) {
      message.setReject("Unknown address");
    }
  },

  async scheduled(_controller, env): Promise<void> {
    await deleteExpiredInboxes(env);
  },
} satisfies ExportedHandler<Env>;
