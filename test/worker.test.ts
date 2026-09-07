import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addMessage, createInbox, inboxIsLive } from "../src/inbox";
import worker from "../src/index";

const base = "https://agent-inbox.example";

async function call(path: string, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${base}${path}`, { method }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  return response;
}

describe("POST /inboxes", () => {
  it("creates an inbox", async () => {
    const response = await call("/inboxes", "POST");

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      address: expect.stringContaining(`@${env.INBOX_DOMAIN}`),
      local_part: expect.any(String),
      expires_at: expect.any(Number),
    });
  });
});

describe("GET /inboxes/:local_part/messages", () => {
  it("lists messages", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, {
      envelope_from: "sender@example.com",
      subject: "hello",
      body_text: "plain",
      body_html: null,
    });

    const response = await call(`/inboxes/${local_part}/messages`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ subject: "hello" }]);
  });

  it("404s on an unknown inbox", async () => {
    expect((await call("/inboxes/nosuchinbox/messages")).status).toBe(404);
  });
});

describe("GET /inboxes/:local_part/messages/:id", () => {
  it("returns the body", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, {
      envelope_from: "sender@example.com",
      subject: "hello",
      body_text: "plain",
      body_html: "<p>html</p>",
    });
    const [message] = (await (
      await call(`/inboxes/${local_part}/messages`)
    ).json()) as { id: number }[];

    const response = await call(
      `/inboxes/${local_part}/messages/${message.id}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      body_text: "plain",
      body_html: "<p>html</p>",
    });
  });

  it("404s on an unknown id", async () => {
    const { local_part } = await createInbox(env);

    expect((await call(`/inboxes/${local_part}/messages/999999`)).status).toBe(
      404,
    );
  });
});

describe("unmatched requests", () => {
  it("answers the root", async () => {
    const response = await call("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("404s an unknown path", async () => {
    expect((await call("/nope")).status).toBe(404);
  });

  it("404s a known path on the wrong method", async () => {
    expect((await call("/inboxes")).status).toBe(404);
    expect((await call("/inboxes/whatever/messages", "DELETE")).status).toBe(
      404,
    );
  });
});

describe("email", () => {
  it("rejects an email no inbox accepts", async () => {
    const rejected: string[] = [];
    const message = {
      to: `nosuchinbox@${env.INBOX_DOMAIN}`,
      from: "sender@example.com",
      raw: new Response("").body,
      headers: new Headers(),
      setReject: (reason: string) => rejected.push(reason),
    } as unknown as ForwardableEmailMessage;

    await worker.email(message, env);

    expect(rejected).toEqual(["Unknown address"]);
  });
});

describe("scheduled", () => {
  it("sweeps expired inboxes", async () => {
    await env.DB.prepare(
      "insert into inboxes (local_part, created_at, expires_at) values ('expired', 1, 2)",
    ).run();
    const live = await createInbox(env);

    await worker.scheduled(createScheduledController(), env);

    expect(await inboxIsLive(env, "expired")).toBe(false);
    expect(await inboxIsLive(env, live.local_part)).toBe(true);
  });
});
