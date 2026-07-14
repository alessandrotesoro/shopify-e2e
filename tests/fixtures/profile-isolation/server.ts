import { createServer } from "node:http";

export interface LoopbackServer {
	readonly close: () => Promise<void>;
	readonly origin: string;
}

export const startLoopbackServer = async (): Promise<LoopbackServer> => {
	const server = createServer((_request, response) => {
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"x-content-type-options": "nosniff",
		});
		response.end("<!doctype html><title>Profile isolation probe</title>");
	});
	await new Promise<void>((resolveListening, rejectListening) => {
		server.once("error", rejectListening);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectListening);
			resolveListening();
		});
	});
	const address = server.address();
	if (typeof address === "string" || address === null) {
		server.close();
		throw new Error("Loopback server did not expose a TCP address");
	}
	return {
		close: () =>
			new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			),
		origin: `http://127.0.0.1:${address.port}`,
	};
};
