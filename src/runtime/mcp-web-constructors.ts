import { Response } from "undici/lib/web/fetch/response.js";
import { Request } from "undici/lib/web/fetch/request.js";
import { Headers } from "undici/lib/web/fetch/headers.js";

// The Node MCP adapter captures these constructors while loading. Keep the
// provided HTTP message types separate from the Extension's Fetch transport.
// Undici initializes the BodyInit converter in Response before Request captures it.
for (const [name, value] of Object.entries({ Request, Response, Headers })) {
  if (!Object.hasOwn(globalThis, name)) Object.defineProperty(globalThis, name, { value, configurable: true });
}
