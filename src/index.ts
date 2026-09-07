export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response("ok");
	},

	async email(message, env, ctx): Promise<void> {
		console.log("email received", {
			from: message.from,
			to: message.to,
			subject: message.headers.get("subject"),
			size: message.rawSize,
		});
	},
} satisfies ExportedHandler<Env>;
