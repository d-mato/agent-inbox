export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response("ok");
	},
} satisfies ExportedHandler<Env>;
