import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AdminIdentity {
  email: string;
  method: "cloudflare-access" | "recovery-token";
}

type AuthEnv = Pick<Env, "TEAM_DOMAIN" | "POLICY_AUD" | "AUTHORIZED_EMAIL" | "ADMIN_API_TOKEN">;

export function json(data: unknown, status = 200, cache = "no-store"): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": cache,
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

export async function readJson<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new HttpError(413, "请求内容过大");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "请求内容过大");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "请求不是有效的 JSON");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return different === 0;
}

async function accessIdentity(request: Request, env: AuthEnv): Promise<AdminIdentity | null> {
  const teamDomain = env.TEAM_DOMAIN as string;
  const audience = env.POLICY_AUD as string;
  const authorizedEmail = (env.AUTHORIZED_EMAIL as string).trim().toLowerCase();
  const token = request.headers.get("cf-access-jwt-assertion") ?? "";
  if (!teamDomain || !audience || !authorizedEmail || !token) return null;
  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, { issuer: teamDomain.replace(/\/$/, ""), audience });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email === authorizedEmail ? { email, method: "cloudflare-access" } : null;
  } catch {
    return null;
  }
}

export async function authenticateAdmin(request: Request, env: AuthEnv): Promise<AdminIdentity | null> {
  const access = await accessIdentity(request, env);
  if (access) return access;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return token && constantTimeEqual(token, env.ADMIN_API_TOKEN)
    ? { email: "recovery@local", method: "recovery-token" }
    : null;
}

export async function requireAdmin(request: Request, env: AuthEnv): Promise<AdminIdentity> {
  const identity = await authenticateAdmin(request, env);
  if (!identity) throw new HttpError(401, "请使用已授权的 Google 邮箱登录");
  return identity;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
