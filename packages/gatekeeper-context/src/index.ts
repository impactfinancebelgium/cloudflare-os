// Context Library worker: private per-account collections plus public per-domain collections. The
// vendor auto-provisions accounts that expose a read-only agent singleton and a management UI.

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

import { handleAdminApi } from "./admin-api.js";

// IFB fork: /admin-api/* is a bearer-secret programmatic management surface
// (see admin-api.ts); everything else keeps the upstream RPC/DO-only posture.
export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/admin-api")) {
      return handleAdminApi(request, env, ctx);
    }
    return new Response("Context Library worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
