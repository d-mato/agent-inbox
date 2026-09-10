# agent-inbox

Disposable email inboxes for AI agents, served as an MCP server on Cloudflare Workers.

An agent asks for an inbox, hands the address to a website, and waits for the
confirmation mail to arrive. Each inbox is a random address on your own domain
and is deleted seven days later along with everything it received.

## How it works

- **Cloudflare Email Routing** delivers every message sent to your domain to the
  Worker. The Worker keeps the message if a live inbox owns the address and
  rejects it otherwise.
- **D1** stores inboxes and messages.
- **MCP over streamable HTTP** at `/mcp` exposes the tools below. The same
  operations are available as plain HTTP endpoints.
- **A cron trigger** sweeps expired inboxes hourly.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `create_inbox` | Returns `address`, `local_part` (the inbox id used by the other tools) and `expires_at`. |
| `wait_for_message` | Holds the call open until a message newer than `since_id` arrives or a timeout passes, and reports which. |
| `list_messages` | Lists messages newest first, without bodies. |
| `get_message` | Returns one message with `body_text` and `body_html`. |

Each tool's description states its parameters and defaults.

## HTTP API

| Method and path | Response |
| --- | --- |
| `POST /inboxes` | `201` with the same object as `create_inbox` |
| `GET /inboxes/:local_part/messages` | `200` with an array of messages, `404` if the inbox is unknown or expired |
| `GET /inboxes/:local_part/messages/:id` | `200` with the message including bodies, `404` if not found |

## Deploying your own

You need a Cloudflare account and a domain on it as a zone.

1. **Create the database** and put its id in `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create agent-inbox
   npx wrangler d1 migrations apply agent-inbox --remote
   ```

2. **Set your domain** in `wrangler.jsonc`. `INBOX_DOMAIN` is the domain in
   the addresses handed out. `routes` is where the Worker itself is served;
   the example uses the same name for both.

   ```jsonc
   "vars": { "INBOX_DOMAIN": "inbox.example.com" },
   "routes": [{ "pattern": "inbox.example.com", "custom_domain": true }],
   ```

3. **Deploy**:

   ```sh
   npm install
   npm run deploy
   ```

4. **Route mail to the Worker.** In the Cloudflare dashboard, enable Email
   Routing on the zone and set the catch-all action to *Send to a Worker*,
   choosing `agent-inbox`. The catch-all is the only rule that matches the
   random addresses this service generates, and it can only be set per zone.
   It also covers subdomains, so `INBOX_DOMAIN` may be a subdomain of the
   zone. The Worker rejects mail for any other address, so give every other
   address you receive on the zone an explicit rule.

5. **Point an MCP client at it**, for example in Claude Code:

   ```sh
   claude mcp add --transport http agent-inbox https://inbox.example.com/mcp
   ```

## Security

The endpoints have no authentication. Anyone who can reach the Worker can
create inboxes on your domain, and anyone who knows a `local_part` can read
that inbox. Local parts are random and impractical to guess, but inbox
creation is open. Put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
or a WAF rule in front of the routes if that matters for your deployment.

## Development

```sh
npm install
npm test
npm run check
npm run lint
npm run dev
```

Tests run inside the Workers runtime against a D1 database built from
`migrations/`, so they see the same schema as production.

## License

[MIT](LICENSE)
