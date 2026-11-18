import * as react from "react";
import { createRoot } from "react-dom/client";

// Safari on the supported macOS 13 baseline does not yet provide AbortSignal.any.
if (!AbortSignal.any) {
	AbortSignal.any = (signals) => {
		const controller = new AbortController();
		const abort = (event) => controller.abort(event.target.reason);
		controller.signal.addEventListener("abort", () => {
			for (const signal of signals) signal.removeEventListener("abort", abort);
		}, { once: true });
		for (const signal of signals) {
			if (signal.aborted) { controller.abort(signal.reason); break; }
			signal.addEventListener("abort", abort, { once: true });
		}
		return controller.signal;
	};
}

// The DSH panel and the bundled window load the same client factory.
window.__ModuleLoader__ = {
	load({ factory }) {
		const client = factory((name) => {
			if (name !== "react") throw new Error("Unsupported broadcast module: " + name);
			return react;
		});
		client.mountBroadcastWindow(createRoot(document.getElementById("broadcast")));
	},
};
