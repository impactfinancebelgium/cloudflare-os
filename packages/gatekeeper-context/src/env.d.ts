// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
    // IFB fork: bearer secret gating /admin-api/* (Worker secret) and the sharing
    // domain those admin calls operate on (defaults to "production").
    CONTEXT_ADMIN_TOKEN?: string;
    SHARING_DOMAIN?: string;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ContextCollectionDurableObject"
      | "UserLibraryDurableObject"
      | "LibraryRegistryDurableObject"
      | "ContextGatekeeper";
  }
}
