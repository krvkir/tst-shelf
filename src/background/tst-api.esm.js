// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copy of src/background/tst-api.esm.js from tst-workspace, which itself
// copies it verbatim from tst-search by Niklas Gollenstede
// (https://github.com/NiklasGollenstede/tst-search).  tst-shelf carries
// three deliberate deviations from the verbatim copy, all documented in
// the code below and re-verified against the TST 4.4.10 sources
// (~/repos/firefox/treestyletab/webextensions/):
//   1. register() validates the `register-self` response shape
//      (inherited from tst-workspace: TST answers `undefined` transiently
//      while its background initializes).
//   2. onMessageExternal returns the handler's resolved value when it is
//      a boolean.  The verbatim copy returned `true` for every message;
//      but TST's tryOperationAllowed() cancels an operation whenever ANY
//      subscribed listener resolves truthy — with try-collapse-tree-
//      from-other-expansion, try-scroll-to-activated-tab and extra-
//      contents-clicked we MUST answer exactly and only when we cancel.
//   3. Bulk message frames ({ messages: [...] }) are fanned out to the
//      normal switch.  With allowBulkMessaging: true TST coalesces
//      tree-attached/tree-detached/tabs-rendered/sidebar-show into one
//      frame; the verbatim copy would run events[undefined] and fail.

/**
 * Boilerplate code to interact with the *Tree Style Tabs* extension.
 * @param {object}           options                 Options, see below:
 * @param {() => object}     options.getManifest     Function returning the (updated) registration manifest. Called whenever `.register()` is called (automatically or explicitly).
 * @param {string[]=}        options.methods         Optional. TST functions to make available in `.methods`, as the message `.type`s to send to TST.
 *                                                   Names `.methods` will see the same transformation as the `dataset` properties in HTML.
 * @param {Record<string, (params: object) => any|Promise>=}
 *                           options.events          Optional. Handlers for events to subscribe to, where the keys are the `.type`s
 *                                                   of the inbound messages, and the `params` argument is the received message.
 *                                                   Boolean returns are passed to TST as the message response (see deviation 2).
 * @param {(reason: any) => void=}
 *                           options.onError         Optional. Handler for non-critical errors.
 * @param {boolean=}         options.debug           Optional. Whether to print messages to and from TST. This is copied to the return object and can be modified there.
 * @returns {{
 *     register: () => Promise<void>,
 *     unregister: () => Promise<void>,
 *     isRegistered: boolean,
 *     methods: Record<string, (params: object) => Promise<any>>,
 *     debug: boolean,
 * }}                        Object of:
 *                            * `register`: Must be called to initially (usually once after the installation) register the current extension with TST, for which TST must already be loaded (which should usually be the case when a user installs an extension to TST, but there should probably be an UI option to repeat the initial registration).  Depending on the manifest options, the initial registration may trigger user interaction from TST.  Calling this again while `.getManifest()` returns the same JSON is a noop, sending a different manifest updates the registration (i.e. `.register()` is idempotent).  Once initially registered, the registration will be automatic whenever TST (re)starts after this extension, but `register()` must be called explicitly if this extension (re)starts after TST. Usually it is best to just call this when the current extension loads, and ignore the return status.
 *                            * `unregister`: Persistently unregister this extension from TST.
 *                            * `methods`: For every method name passed in, a function that sends a message calling that method. Parameters are those expected my TST, minus the `.type`.
 *                            * `debug`: Updatable copy of the `.debug` parameter.
 */
export default function tstAPI({ getManifest, methods = [ ], events = { __proto__: null, }, onError = console.error, debug = false, }) {
	const TST_ID = 'treestyletab@piro.sakura.ne.jp';
	const ownName = browser.runtime.getManifest().name;

	async function register() {
		const tstManifest = { listeningTypes: [ ...Object.keys(events), 'wait-for-shutdown', ], ...getManifest(), };
		// TST responds with `{grantedPermissions: [...], privateWindowAllowed}`.
		// While its background is still initializing it may return `undefined`
		// without processing the registration; trusting that response (the
		// copied-upstream behavior) left us appearing registered while TST
		// never knew us.  Guard the shape instead.
		const response = (await TST.registerSelf(tstManifest));
		if (!response || typeof response !== 'object' || !('grantedPermissions' in response)) {
			throw new Error(`register-self response invalid: ${response === undefined ? "undefined (TST still initializing?)" : String(response)}`);
		}
		API.isRegistered = true;
	}
	async function unregister() {
		(await TST.unregisterSelf());
		API.isRegistered = false;
	}

	const TST = Object.fromEntries([
		'register-self', 'unregister-self', ...methods,
	].map(name => [
		name.replace(/-([a-z])/g, (_, l) => l.toUpperCase()),
		(options) => {
			API.debug && console.info(ownName +': sendMessageExternal', TST_ID, { ...options, type: name, });
			return browser.runtime.sendMessage(TST_ID, { ...options, type: name, }); // It would be nice if connection errors were distinguishable from errors on TST's side ...
		},
	]));

	// Not `async`: Firefox resolves the caller with the FIRST fulfilled
	// listener reply, and an async function always fulfills on its own
	// microtask — even `return undefined` from it CLOSES the message
	// channel.  Unregistered types below must decline synchronously so
	// other listeners of this extension can still answer (the E2E drives
	// its `test:*` API through this very channel, from the tab-hosted
	// TST sidebar, which is another extension to Firefox).
	function onMessageExternal(message, sender) {
		if (sender.id !== TST_ID) { return false; }

		// Deviation 3: TST 4.0+ coalesces registered bulk notification types
		// into one frame when we registered `allowBulkMessaging: true`.
		// None of the response-sensitive types (try-collapse-...,
		// try-scroll-..., extra-contents-*) are ever bulk, so fan the batch
		// out and answer "handled" at the end.
		if (Array.isArray(message.messages)) {
			return (async () => {
				try {
					for (const one of message.messages) {
						await handleTstMessage(one, sender);
					}
				} catch (error) { onError(error); }
				return true;
			})();
		}

		// Deviation 4: a type this client did not register is NOT ours.
		// (An earlier version answered `true` to everything it did not
		// know — that reply raced and beat the test API's own replies.)
		const type = message.type;
		if (!events[type] && type !== 'ready' && type !== 'wait-for-shutdown') {
			return undefined;
		}

		return handleTstMessage(message, sender);
	}

	async function handleTstMessage(message, sender) {
		API.debug && console.info(ownName +': onMessageExternal', ...arguments);
		try {
			switch (message.type) {
			case 'ready': register().catch(onError); events.ready && (await events.ready(message)); break;
			case 'wait-for-shutdown': await new Promise(resolve => {
				window.addEventListener('beforeunload', () => resolve());
			}); break;
			default: {
				const handler = events[message.type];
					// an unknown BULK member type: the frame reply is already
				// committed, so a plain decline keeps the fan-out honest
				if (!handler) { break; }
				const response = await handler(message);
				// Deviation 2: a boolean verdict goes back to TST verbatim;
				// anything else means "handled, no cancellation".
				return response === undefined ? true : response;
			}
			}
		} catch (error) { onError(error); }
		return true; // indicate to TST that the event was handled
	}

	browser.runtime.onMessageExternal.addListener(onMessageExternal);

	const API = { register, unregister, isRegistered: false, methods: TST, debug, }; return API;
}
