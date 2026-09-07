import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createInbox,
  getMessage,
  inboxSchema,
  listMessages,
  messageDetailSchema,
  messageSchema,
  waitForMessages,
} from "./inbox";

// Clients time out a tool call after DEFAULT_REQUEST_TIMEOUT_MSEC (60s) and do
// not extend it on progress notifications unless they opt in, so a wait has to
// end well inside that and let the caller ask again.
const WAIT_DEFAULT_SECONDS = 45;
const WAIT_MAX_SECONDS = 55;

export function waitTimeoutMs(seconds = WAIT_DEFAULT_SECONDS): number {
  return Math.min(seconds, WAIT_MAX_SECONDS) * 1000;
}

export function createServer(env: Env) {
  const server = new McpServer({ name: "agent-inbox", version: "1.0.0" });

  server.registerTool(
    "create_inbox",
    {
      description:
        "Create a new inbox. Returns the email address to hand out, the local_part that identifies it in the other tools, and expires_at (unix seconds) after which the inbox stops receiving and reading.",
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
    "wait_for_message",
    {
      description:
        "Wait for mail to arrive at an inbox and return it, so you do not have to poll list_messages. Use this right after handing the address to a site. Returns as soon as a message newer than since_id arrives; if none does, returns after timeout_seconds with timed_out true and no messages, and you can call again. since_id defaults to 0, which accepts anything the inbox already holds. timeout_seconds defaults to 45 and is capped at 55. Returns null messages if no such inbox exists.",
      inputSchema: z.object({
        local_part: z.string(),
        since_id: z.number().int().nonnegative().optional(),
        timeout_seconds: z.number().int().positive().optional(),
      }),
      outputSchema: z.object({
        messages: z.array(messageSchema).nullable(),
        timed_out: z.boolean(),
      }),
    },
    async ({ local_part, since_id, timeout_seconds }, ctx) => {
      const messages = await waitForMessages(
        env,
        local_part,
        since_id ?? 0,
        waitTimeoutMs(timeout_seconds),
        ctx.mcpReq.signal,
      );
      const result = { messages, timed_out: messages?.length === 0 };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
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
