// IFB fork: programmatic admin API for context collections.
//
// The upstream management surface only exists as an app-UI RpcStub handed out by
// ContextAccount.startAppUi(), and this build's frontend does not ship that app
// yet, so there is NO human-clickable path to create a collection. This endpoint
// makes collection management scriptable instead: an agent (or CI) can create
// git-backed collections, mint git tokens and trigger syncs over plain HTTP.
//
// Security: every request needs `Authorization: Bearer <CONTEXT_ADMIN_TOKEN>`
// (a Worker secret; constant-time compared). Calls run with isAdmin=true and an
// empty account id, so collections should be created as "public" (domain-wide),
// which is exactly what shared team context wants.

import { ContextApiImpl } from "./context-api.js";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 1), {
    status,
    headers: { "content-type": "application/json" },
  });

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function handleAdminApi(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const secret = env.CONTEXT_ADMIN_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(auth, `Bearer ${secret}`)) {
    return new Response("unauthorized", { status: 401 });
  }

  const api = new ContextApiImpl(
    env,
    env.SHARING_DOMAIN ?? "production",
    "",
    true,
    ctx.exports.ContextCollectionDurableObject,
    ctx.exports.UserLibraryDurableObject,
    ctx.exports.LibraryRegistryDurableObject,
  );

  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/admin-api\/?/, "").split("/").filter(Boolean);

  try {
    // GET /admin-api/info -> capability check
    if (request.method === "GET" && parts[0] === "info") {
      return json(await api.getViewerInfo());
    }

    // POST /admin-api/collections {title, description, source?, visibility?, icon?}
    if (request.method === "POST" && parts.length === 1 && parts[0] === "collections") {
      const body = (await request.json()) as {
        title?: string; description?: string; icon?: string;
        source?: "web" | "git"; visibility?: "public" | "private";
      };
      if (!body.title) return json({ error: "title is required" }, 400);
      const metadata = await api.createContextCollection(
        body.title,
        body.description ?? "",
        body.visibility ?? "public",
        body.icon,
        body.source ?? "git",
      );
      return json(metadata, 201);
    }

    // Routes addressing one collection: /admin-api/collections/<id>[/...]
    if (parts[0] === "collections" && parts[1]) {
      const id = parts[1];
      if (request.method === "GET" && parts.length === 2) {
        const metadata = await api.getContextCollectionMetadata(id);
        return metadata ? json(metadata) : json({ error: "not found" }, 404);
      }
      if (request.method === "POST" && parts[2] === "git-token") {
        return json(await api.createContextCollectionGitToken(id), 201);
      }
      if (request.method === "POST" && parts[2] === "sync") {
        await api.syncContextCollectionArtifactSource(id);
        return json({ synced: true });
      }
      if (request.method === "GET" && parts[2] === "documents") {
        return json(await api.listContextDocuments(id, url.searchParams.get("prefix") ?? undefined));
      }
    }

    return json({ error: "unknown admin-api route" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
