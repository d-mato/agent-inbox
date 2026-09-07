import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { waitTimeoutMs } from "../src/mcp";

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://agent-inbox.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  const text = await response.text();
  const event = text.split("\n").find((line) => line.startsWith("data: "));

  return JSON.parse(event ? event.slice("data: ".length) : text).result as T;
}

describe("waitTimeoutMs", () => {
  it("defaults to 45s and caps at 55s, under the 60s client timeout", () => {
    expect(waitTimeoutMs()).toBe(45_000);
    expect(waitTimeoutMs(10)).toBe(10_000);
    expect(waitTimeoutMs(999)).toBe(55_000);
  });
});

describe("mcp", () => {
  it("exposes the three tools", async () => {
    const { tools } = await rpc<{ tools: { name: string }[] }>("tools/list");

    expect(tools.map((tool) => tool.name)).toEqual([
      "create_inbox",
      "list_messages",
      "wait_for_message",
      "get_message",
    ]);
  });

  it("creates an inbox", async () => {
    const { structuredContent } = await rpc<{
      structuredContent: { address: string; local_part: string };
    }>("tools/call", {
      name: "create_inbox",
      arguments: {},
    });

    expect(structuredContent.address).toBe(
      `${structuredContent.local_part}@${env.INBOX_DOMAIN}`,
    );
  });

  it("waits for a message and reports the timeout", async () => {
    const created = await rpc<{
      structuredContent: { local_part: string };
    }>("tools/call", { name: "create_inbox", arguments: {} });

    const { structuredContent } = await rpc<{
      structuredContent: { messages: unknown[] | null; timed_out: boolean };
    }>("tools/call", {
      name: "wait_for_message",
      arguments: {
        local_part: created.structuredContent.local_part,
        timeout_seconds: 1,
      },
    });

    expect(structuredContent).toEqual({ messages: [], timed_out: true });
  });

  it("reports an unknown inbox as null", async () => {
    const { structuredContent } = await rpc<{
      structuredContent: { messages: unknown[] | null };
    }>("tools/call", {
      name: "list_messages",
      arguments: { local_part: "nosuchinbox" },
    });

    expect(structuredContent.messages).toBeNull();
  });
});
