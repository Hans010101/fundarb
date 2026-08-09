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

export function isAdmin(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return Boolean(token && constantTimeEqual(token, env.ADMIN_API_TOKEN));
}

export function requireAdmin(request: Request, env: Env): void {
  if (!isAdmin(request, env)) throw new HttpError(401, "管理凭证无效");
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
