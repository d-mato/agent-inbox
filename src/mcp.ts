import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  createInbox,
  getMessage,
  inboxSchema,
  listMessages,
  messageDetailSchema,
  messageSchema,
} from "./inbox";

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
