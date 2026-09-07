export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response("ok");
	},

	async email(message, env, ctx): Promise<void> {
		const localPart = message.to.split("@")[0].toLowerCase();

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
