import { DurableObject } from "cloudflare:workers";

export interface Env {
  CORETALK_HOOKS_ROOMS: DurableObjectNamespace;
  /** JSON string: either one IP (`"x.x.x.x"`) or an array (`["a","b"]`). */
  ALLOWED_IPS?: string;
}

type OutEvent =
  | {
      type: "notify";
      header: string;
      body: string;
      icon?: string;
      ts: number;
    }
  | {
      type: "toast";
      body: string;
      ts: number;
    }
  | {
      type: "dialog";
      title: string;
      body: string;
      kind?: "info" | "success" | "warning" | "error" | "question";
      ts: number;
    }
  | {
      type: "confirm";
      title: string;
      body: string;
      url: string;
      kind?: "info" | "success" | "warning" | "error" | "question";
      ts: number;
    };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket endpoint
    if (url.pathname.startsWith("/ws/")) {
      const username = clean(url.pathname.slice(4));
      if (!username) return new Response("Bad username", { status: 400 });

      const id = env.CORETALK_HOOKS_ROOMS.idFromName(username);
      return env.CORETALK_HOOKS_ROOMS.get(id).fetch(request);
    }

    // Webhook endpoint
    if (request.method === "POST") {
      const username = clean(url.pathname.slice(1));
      if (!username) return new Response("Bad username", { status: 400 });

      const allowedIPs = parseAllowedIPs(env.ALLOWED_IPS);

      const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        "";

      if (!allowedIPs.includes(ip)) {
        return new Response("Forbidden", { status: 403 });
      }

      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return new Response("Bad JSON", { status: 400 });
      }

      const event = buildEvent(payload as Record<string, unknown>);
      if (!event) {
        return new Response("Bad payload", { status: 400 });
      }

      const id = env.CORETALK_HOOKS_ROOMS.idFromName(username);
      await env.CORETALK_HOOKS_ROOMS.get(id).fetch("https://internal/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });

      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }
};

function clean(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** Secret is JSON: one IP as a string, or several as a string array. */
function parseAllowedIPs(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return [];
  }
  if (typeof parsed === "string") {
    const ip = parsed.trim();
    return ip ? [ip] : [];
  }
  if (Array.isArray(parsed)) {
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function s(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

type UiKind = "info" | "success" | "warning" | "error" | "question";

function kind(v: unknown): UiKind | undefined {
  if (
    v === "info" ||
    v === "success" ||
    v === "warning" ||
    v === "error" ||
    v === "question"
  ) {
    return v;
  }
  return undefined;
}

function buildEvent(payload: Record<string, unknown>): OutEvent | null {
  const type = s(payload.type) || "notify";
  const ts = Date.now();

  if (type === "notify") {
    const body =
      s(payload.body) ||
      s(payload.message) ||
      (payload.title != null ? String(payload.title) : undefined) ||
      JSON.stringify(payload);

    const header =
      s(payload.header) ||
      s(payload.title) ||
      "Webhook";

    const icon = s(payload.icon);

    return icon
      ? { type: "notify", header, body, icon, ts }
      : { type: "notify", header, body, ts };
  }

  if (type === "toast") {
    const body =
      s(payload.body) ||
      s(payload.text) ||
      s(payload.message);

    if (!body) return null;

    return { type: "toast", body, ts };
  }

  if (type === "dialog") {
    const title = s(payload.title);
    const body = s(payload.body);

    if (!title || !body) return null;

    const k = kind(payload.kind);
    return k
      ? { type: "dialog", title, body, kind: k, ts }
      : { type: "dialog", title, body, ts };
  }

  if (type === "confirm") {
    const title = s(payload.title);
    const body = s(payload.body);
    const url = s(payload.url);

    if (!title || !body || !url) return null;

    const k = kind(payload.kind);
    return k
      ? { type: "confirm", title, body, url, kind: k, ts }
      : { type: "confirm", title, body, url, ts };
  }

  return null;
}

export class UserRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket connect
    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "hello" }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // Publish event
    if (url.pathname === "/publish" && request.method === "POST") {
      const msg = await request.text();

      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {}
      }

      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }
}
