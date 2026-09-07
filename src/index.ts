export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/inboxes") {
			const localPart = crypto.randomUUID().replace(/-/g, "");

			await env.DB.prepare("insert into inboxes (local_part) values (?)")
				.bind(localPart)
				.run();

			return Response.json(
				{ address: `${localPart}@${env.INBOX_DOMAIN}` },
				{ status: 201 },
			);
		}

		const match = url.pathname.match(/^\/inboxes\/([^/]+)\/messages$/);

		if (request.method === "GET" && match) {
			const { results } = await env.DB.prepare(
				"select id, envelope_from, subject, received_at from messages where local_part = ? order by id desc limit 100",
			)
				.bind(match[1].toLowerCase())
				.all();

			return Response.json(results);
		}

		return new Response("ok");
	},

	async email(message, env, ctx): Promise<void> {
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
