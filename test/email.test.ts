import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deliverEmail } from "../src/email";
import { createInbox, getMessage, listMessages } from "../src/inbox";

function mime(to: string): string {
  return [
    "From: Sender <sender@example.com>",
    `To: ${to}`,
    "Subject: =?UTF-8?B?44OG44K544OI5Lu25ZCN?=",
    "Message-ID: <test@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="bnd"',
    "",
    "--bnd",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain body",
    "--bnd",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html body</p>",
    "--bnd--",
    "",
  ].join("\r\n");
}

function incoming(to: string) {
  return {
    to,
    from: "sender@example.com",
    raw: new Response(mime(to)).body as ReadableStream<Uint8Array>,
    headers: new Headers(),
  };
}

describe("deliverEmail", () => {
  it("stores the decoded subject and both bodies", async () => {
    const inbox = await createInbox(env);

    expect(await deliverEmail(env, incoming(inbox.address))).toBe(true);

    const [listed] = (await listMessages(env, inbox.local_part)) ?? [];
    const message = await getMessage(env, inbox.local_part, listed.id);

    expect(message).toMatchObject({
      envelope_from: "sender@example.com",
      subject: "テスト件名",
      body_text: "plain body\n",
      body_html: "<p>html body</p>\n",
    });
  });

  it("matches the address case-insensitively", async () => {
    const inbox = await createInbox(env);

    expect(await deliverEmail(env, incoming(inbox.address.toUpperCase()))).toBe(
      true,
    );
    expect(await listMessages(env, inbox.local_part)).toHaveLength(1);
  });

  it("refuses another domain, even when the local part exists", async () => {
    const inbox = await createInbox(env);
    // Same length as the inbox domain, so stripping the domain without
    // checking it would leave exactly the live local part.
    const lookalike = env.INBOX_DOMAIN.replace(/[^.]/g, "x");

    expect(
      await deliverEmail(env, incoming(`${inbox.local_part}@${lookalike}`)),
    ).toBe(false);
    expect(await listMessages(env, inbox.local_part)).toEqual([]);
  });

  it("refuses an unknown inbox", async () => {
    expect(
      await deliverEmail(env, incoming(`nosuchinbox@${env.INBOX_DOMAIN}`)),
    ).toBe(false);
  });

  it("refuses an expired inbox", async () => {
    await env.DB.prepare(
      "insert into inboxes (local_part, created_at, expires_at) values ('expired', 1, 2)",
    ).run();

    expect(
      await deliverEmail(env, incoming(`expired@${env.INBOX_DOMAIN}`)),
    ).toBe(false);
  });
});
