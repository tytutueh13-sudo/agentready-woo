// Account auth primitives: PBKDF2-SHA256 password hashing and opaque session
// tokens (only the SHA-256 of a token is stored; the raw token lives only in
// the merchant's cookie). Constant-time comparison everywhere it matters.

const PBKDF2_ITERATIONS = 100_000;

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map(v => v.toString(16).padStart(2, "0")).join("");
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    throw new Error("password must be 8-200 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${hex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  let salt: Uint8Array;
  try { salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0)); } catch { return false; }
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial, 256,
  );
  const expected = parts[3];
  let actual = "";
  // constant-time-ish compare via fixed-work digest comparison
  actual = hex(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export function isValidEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export const SESSION_COOKIE = "arw_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(request: Request): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}
