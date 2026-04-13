export interface Env {
  /** Base URL, e.g. https://coretalk.space (no trailing slash) */
  MISSKEY_ORIGIN: string;
  /** Misskey API token (`i`) — use secret in production */
  MISSKEY_TOKEN: string;
  /** JSON string: one IP or array of IPs for webhook allowlist */
  ALLOWED_IPS?: string;
}

/** Minimum delay between Misskey API calls (rate limiting). */
const API_CALL_GAP_MS = 150;
/** Max recipients per `notes/create` (specified visibility); chunk above this. */
const MAX_VISIBLE_USERS_PER_NOTE = 20;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

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

    const rec = payload as Record<string, unknown>;
    const pathUser = cleanPathUser(url.pathname);
    const users = collectTargetUsers(rec, pathUser);
    if (users.length === 0) {
      return new Response("Bad username: set path /:user or body.users", {
        status: 400
      });
    }

    const event = buildEvent(rec);
    if (!event) {
      return new Response("Bad payload", { status: 400 });
    }

    const text = eventToMisskeyText(event);
    const result = await sendDirectMessage(env, users, text);

    if (result.errors.length > 0 && result.sent === 0) {
      return Response.json(
        { ok: false, sent: 0, errors: result.errors },
        { status: 502 }
      );
    }

    if (result.errors.length > 0) {
      return Response.json({
        ok: true,
        sent: result.sent,
        errors: result.errors
      });
    }

    return new Response(null, { status: 204 });
  }
};

function cleanPathUser(pathname: string): string {
  const seg = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return clean(seg);
}

function clean(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function collectTargetUsers(
  payload: Record<string, unknown>,
  pathUser: string
): string[] {
  const raw = payload.users ?? payload.to;
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    list = raw.split(/[\s,]+/);
  } else if (pathUser) {
    return [pathUser];
  }
  const out = list
    .map((x) => (typeof x === "string" ? clean(x) : ""))
    .filter(Boolean);
  const uniq = [...new Set(out)];
  if (uniq.length > 0) return uniq;
  return pathUser ? [pathUser] : [];
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function misskeyOrigin(env: Env): string {
  return env.MISSKEY_ORIGIN.replace(/\/$/, "");
}

async function misskeyApi<T>(
  env: Env,
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const url = `${misskeyOrigin(env)}/api${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, i: env.MISSKEY_TOKEN })
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, text };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 502, text: "invalid JSON from Misskey" };
  }
}

/** Resolve local username to user id (Misskey /api/users/show). */
export async function resolveUsernameToUserId(
  env: Env,
  username: string
): Promise<string | null> {
  const r = await misskeyApi<{ id: string }>(env, "/users/show", {
    username
  });
  if (!r.ok || !r.data?.id) return null;
  return r.data.id;
}

/**
 * Send direct-style notes (`visibility: specified`, `localOnly`) so Misskey
 * delivers a **mention** notification to each recipient’s bell (see Misskey
 * NoteCreateService: visible users are queued as mentions). There is no API to
 * call `notifications/create` for other users’ accounts with a single bot token.
 */
export async function sendDirectMessage(
  env: Env,
  users: string[],
  text: string
): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  const pairs: { user: string; id: string }[] = [];
  const seenId = new Set<string>();

  for (const u of users) {
    const id = await resolveUsernameToUserId(env, u);
    if (!id) {
      errors.push(`users/show failed or unknown user: ${u}`);
    } else if (!seenId.has(id)) {
      seenId.add(id);
      pairs.push({ user: u, id });
    }
    await sleep(API_CALL_GAP_MS);
  }

  if (pairs.length === 0) {
    return { sent: 0, errors };
  }

  let sent = 0;

  for (let i = 0; i < pairs.length; i += MAX_VISIBLE_USERS_PER_NOTE) {
    const chunk = pairs.slice(i, i + MAX_VISIBLE_USERS_PER_NOTE);
    const visibleUserIds = chunk.map((p) => p.id);
    const mentionLine = chunk.map((p) => `@${p.user}`).join(" ");
    const noteText = `${mentionLine}\n${text}`;

    const r = await misskeyApi<unknown>(env, "/notes/create", {
      text: noteText,
      visibility: "specified",
      visibleUserIds,
      localOnly: true
    });
    if (!r.ok) {
      errors.push(
        `notes/create failed (${r.status}): ${r.text.slice(0, 500)}`
      );
    } else {
      sent += chunk.length;
    }
    await sleep(API_CALL_GAP_MS);
  }

  return { sent, errors };
}

type OutEvent =
  | { type: "notify"; header: string; body: string; icon?: string; ts: number }
  | { type: "toast"; body: string; ts: number }
  | {
      type: "dialog";
      title: string;
      body: string;
      kind?: UiKind;
      ts: number;
    }
  | {
      type: "confirm";
      title: string;
      body: string;
      url: string;
      kind?: UiKind;
      ts: number;
    };

type UiKind = "info" | "success" | "warning" | "error" | "question";

function withOk(url: string): string {
  return url.includes("?") ? `${url}&ok=1` : `${url}?ok=1`;
}

function eventToMisskeyText(ev: OutEvent): string {
  switch (ev.type) {
    case "toast":
      return ev.body;
    case "notify":
      return `${ev.header}\n${ev.body}`;
    case "dialog":
      return `${ev.title}\n${ev.body}`;
    case "confirm":
      return `${ev.title}\n${ev.body}\n${withOk(ev.url)}`;
    default: {
      const _x: never = ev;
      return _x;
    }
  }
}

function s(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

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
      s(payload.header) || s(payload.title) || "Webhook";

    const icon = s(payload.icon);

    return icon
      ? { type: "notify", header, body, icon, ts }
      : { type: "notify", header, body, ts };
  }

  if (type === "toast") {
    const body =
      s(payload.body) || s(payload.text) || s(payload.message);

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
