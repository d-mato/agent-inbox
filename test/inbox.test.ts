import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  addMessage,
  createInbox,
  deleteExpiredInboxes,
  getMessage,
  inboxIsLive,
  listMessages,
  waitForMessages,
} from "../src/inbox";

const SEVEN_DAYS = 7 * 24 * 60 * 60;

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

async function insertExpiredInbox(localPart: string): Promise<void> {
  await env.DB.prepare(
    "insert into inboxes (local_part, created_at, expires_at) values (?, ?, ?)",
  )
    .bind(localPart, 1, 2)
    .run();
}

const body = {
  envelope_from: "sender@example.com",
  subject: "hello",
  body_text: "plain",
  body_html: "<p>html</p>",
};

describe("createInbox", () => {
  it("hands out an address on the inbox domain", async () => {
    const inbox = await createInbox(env);

    expect(inbox.local_part).toMatch(/^[0-9a-f]{32}$/);
    expect(inbox.address).toBe(`${inbox.local_part}@${env.INBOX_DOMAIN}`);
  });

  it("expires seven days out", async () => {
    const before = unixNow();
    const inbox = await createInbox(env);

    expect(inbox.expires_at).toBeGreaterThanOrEqual(before + SEVEN_DAYS);
    expect(inbox.expires_at).toBeLessThanOrEqual(unixNow() + SEVEN_DAYS);
  });
});

describe("listMessages", () => {
  it("returns the newest message first, without bodies", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, { ...body, subject: "first" });
    await addMessage(env, local_part, { ...body, subject: "second" });

    const messages = await listMessages(env, local_part);

    expect(messages?.map((m) => m.subject)).toEqual(["second", "first"]);
    expect(messages?.[0]).not.toHaveProperty("body_text");
  });

  it("returns an empty array for an inbox that received nothing", async () => {
    const { local_part } = await createInbox(env);

    expect(await listMessages(env, local_part)).toEqual([]);
  });

  it("returns null for an unknown inbox", async () => {
    expect(await listMessages(env, "nosuchinbox")).toBeNull();
  });

  it("skips messages at or before sinceId", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, { ...body, subject: "first" });
    await addMessage(env, local_part, { ...body, subject: "second" });
    const [newest, oldest] = (await listMessages(env, local_part)) ?? [];

    expect(await listMessages(env, local_part, oldest.id)).toEqual([newest]);
    expect(await listMessages(env, local_part, newest.id)).toEqual([]);
  });
});

describe("waitForMessages", () => {
  it("returns straight away when the inbox already holds one", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, body);

    expect(await waitForMessages(env, local_part, 0, 10_000)).toHaveLength(1);
  });

  it("returns null for an unknown inbox", async () => {
    expect(await waitForMessages(env, "nosuchinbox", 0, 10_000)).toBeNull();
  });

  it("returns empty once the deadline passes", async () => {
    const { local_part } = await createInbox(env);

    expect(await waitForMessages(env, local_part, 0, 100)).toEqual([]);
  });

  it("keeps waiting while the only message is at or before sinceId", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, body);
    const [existing] = (await listMessages(env, local_part)) ?? [];

    expect(await waitForMessages(env, local_part, existing.id, 100)).toEqual(
      [],
    );
  });

  it("returns a message that arrives during the wait", async () => {
    const { local_part } = await createInbox(env);
    const delivery = new Promise((resolve) => setTimeout(resolve, 50)).then(
      () => addMessage(env, local_part, { ...body, subject: "late" }),
    );

    const messages = await waitForMessages(env, local_part, 0, 1_000);

    await delivery;
    expect(messages?.map((m) => m.subject)).toEqual(["late"]);
  });

  it("gives up as soon as the caller aborts", async () => {
    const { local_part } = await createInbox(env);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    const messages = await waitForMessages(
      env,
      local_part,
      0,
      3_000,
      controller.signal,
    );

    expect(messages).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("getMessage", () => {
  it("returns the bodies", async () => {
    const { local_part } = await createInbox(env);
    await addMessage(env, local_part, body);
    const [message] = (await listMessages(env, local_part)) ?? [];

    expect(await getMessage(env, local_part, message.id)).toMatchObject({
      envelope_from: "sender@example.com",
      subject: "hello",
      body_text: "plain",
      body_html: "<p>html</p>",
    });
  });

  it("does not leak a message to another inbox", async () => {
    const owner = await createInbox(env);
    const other = await createInbox(env);
    await addMessage(env, owner.local_part, body);
    const [message] = (await listMessages(env, owner.local_part)) ?? [];

    expect(await getMessage(env, other.local_part, message.id)).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const { local_part } = await createInbox(env);

    expect(await getMessage(env, local_part, 999999)).toBeNull();
  });
});

describe("expiry", () => {
  it("hides an expired inbox and its messages", async () => {
    await insertExpiredInbox("expired");
    await addMessage(env, "expired", body);

    expect(await inboxIsLive(env, "expired")).toBe(false);
    expect(await listMessages(env, "expired")).toBeNull();
    expect(await getMessage(env, "expired", 1)).toBeNull();
  });
});

describe("deleteExpiredInboxes", () => {
  it("deletes expired inboxes along with their messages", async () => {
    await insertExpiredInbox("sweepme");
    await addMessage(env, "sweepme", body);

    await deleteExpiredInboxes(env);

    const { results } = await env.DB.prepare(
      "select (select count(*) from inboxes where local_part = 'sweepme') as inboxes, (select count(*) from messages where local_part = 'sweepme') as messages",
    ).all();

    expect(results[0]).toEqual({ inboxes: 0, messages: 0 });
  });

  it("keeps live inboxes", async () => {
    const { local_part } = await createInbox(env);

    await deleteExpiredInboxes(env);

    expect(await inboxIsLive(env, local_part)).toBe(true);
  });
});
