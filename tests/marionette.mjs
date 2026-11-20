/**
 * Minimal Mozilla Marionette protocol-3 client (Firefox 158).
 *
 * Wire format, verified against the Firefox 158 sources shipped in
 * /usr/lib/firefox/omni.ja (chrome/remote/content/marionette/):
 *   - on connect the server sends one RAW JSON object (no length prefix):
 *     {"applicationType":"gecko","marionetteProtocol":3}
 *     (server.sys.mjs sayHello(), the only unframed message)
 *   - every other message is a "<byteLength>:<utf8-json>" frame
 *     (packets.sys.mjs JSONPacket.write)
 *   - client command payload: [0, msgId, commandName, params]
 *     (message.sys.mjs Command.Type = 0)
 *   - server response payload: [1, msgId, error, result]
 *     (message.sys.mjs Response.Type = 1)
 * Command names are the method names of driver.sys.mjs, e.g. "newSession",
 * "setContext", "executeScript", "get".
 */
"use strict";
import net from "node:net";

const RESPONSE_TYPE = 1;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 180_000;

export class Marionette {
	#socket = null;
	#nextId = 0;
	#pending = new Map;
	#buf = Buffer.alloc(0);
	#error = null;

	/** Resolves with the server handshake object, rejects on timeout/error. */
	connect (port, host = "127.0.0.1") {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ port, host, });
			this.#socket = socket;
			this.#error = null;
			socket.once("error", error => { this.#error = error; reject(error); });
			socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
				this.#error = new Error("marionette: connect timeout");
				reject(this.#error);
			});
			// the hello frame contains no ':' prefix; scan by hand
			let hello = "";
			const onHelloData = chunk => {
				hello += String(chunk);
				const start = hello.indexOf("{");
				if (start < 0) { return; }
				try {
					const handshake = JSON.parse(hello.slice(start));
					socket.setTimeout(0);
					socket.off("data", onHelloData);
					socket.on("data", chunk => this.#onData(chunk));
					resolve(handshake);
				} catch (_e) { /* partial chunk; keep buffering */ }
			};
			socket.on("data", onHelloData);
			socket.on("connect", () => { socket.setTimeout(HANDSHAKE_TIMEOUT_MS); });
		});
	}

	#onData (chunk) {
		this.#buf = Buffer.concat([this.#buf, chunk]);
		for (;;) {
			const colon = this.#buf.indexOf(":");
			if (colon < 0) { return; }
			const header = this.#buf.subarray(0, colon).toString("utf8");
			const length = Number(header);
			if (!Number.isInteger(length) || length < 0) { // garbage; resync
				this.#buf = this.#buf.subarray(colon + 1);
				continue;
			}
			const start = colon + 1;
			if (this.#buf.length - start < length) { return; }
			const body = this.#buf.subarray(start, start + length).toString("utf8");
			this.#buf = this.#buf.subarray(start + length);
			const [type, id, error, result] = (JSON.parse(body));
			if (type !== RESPONSE_TYPE) { continue; }
			const entry = this.#pending.get(id);
			if (!entry) { continue; }
			this.#pending.delete(id);
			entry(error, result);
		}
	}

	command (name, params = { }) {
		return new Promise((resolve, reject) => {
			if (this.#error) { reject(new Error(`marionette: socket error ${this.#error.message}`)); return; }
			if (!this.#socket) { reject(new Error("marionette: not connected")); return; }
			const id = ++this.#nextId;
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`marionette: ${name} timed out after ${COMMAND_TIMEOUT_MS}ms`));
			}, COMMAND_TIMEOUT_MS);
			this.#pending.set(id, (error, result) => {
				clearTimeout(timeout);
				if (error) { reject(new Error(`marionette ${name}: ${error.message || JSON.stringify(error)}`)); }
				else { resolve(result); }
			});
			const frame = JSON.stringify([0, id, name, params]);
			this.#socket.write(`${Buffer.byteLength(frame)}:${frame}`);
		});
	}

	destroy () { this.#socket?.destroy(); this.#pending.clear(); }
}
