// Tenant helpers: per-store Woo credential encryption (AES-GCM) and plan
// limits. The encryption key is derived from APP_ENCRYPTION_SECRET (falling
// back to CART_SIGNING_SECRET so a single operator secret works for MVP).
import type { ServiceConfig } from "../service.ts";
import { offerLimitFor, type PlanKey, type StoreRow } from "./appStore.ts";

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function encryptionSecret(env: Record<string, string | undefined>): string {
  const secret = env.APP_ENCRYPTION_SECRET || env.CART_SIGNING_SECRET || "";
  if (!secret) throw new Error("APP_ENCRYPTION_SECRET or CART_SIGNING_SECRET is required for credential storage");
  return secret;
}

export async function encryptSecret(secret: string, masterKey: string): Promise<string> {
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(secret),
  );
  const bytes = new Uint8Array(cipher);
  const prefixed = new Uint8Array(12 + bytes.length);
  prefixed.set(iv, 0); prefixed.set(bytes, 12);
  let binary = "";
  for (const byte of prefixed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function decryptSecret(encrypted: string, masterKey: string): Promise<string> {
  const raw = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  if (raw.length <= 12) throw new Error("ciphertext too short");
  const key = await deriveKey(masterKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) as BufferSource }, key, raw.slice(12) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

export async function storeServiceConfig(
  store: StoreRow, env: Record<string, string | undefined>, publicBaseUrl: string,
): Promise<{ config: ServiceConfig; consumerSecret: string }> {
  const master = encryptionSecret(env);
  const consumerKey = await decryptSecret(store.wooKeyEnc, master);
  const consumerSecret = await decryptSecret(store.wooSecretEnc, master);
  return {
    consumerSecret,
    config: {
      storeUrl: store.storeUrl,
      consumerKey,
      consumerSecret,
      cartSigningSecret: env.CART_SIGNING_SECRET || "",
      publicBaseUrl,
    },
  };
}

export function normalizeStoreUrl(url: string): string {
  const trimmed = String(url ?? "").trim();
  if (trimmed.length > 200) throw new Error("store URL too long");
  let parsed: URL;
  try { parsed = new URL(trimmed); }
  catch { throw new Error("store URL must be a valid https:// origin"); }
  if (parsed.protocol !== "https:") throw new Error("store URL must be https://");
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error("store URL must be a public https:// origin");
  }
  if (!/^\/*$/.test(parsed.pathname)) {
    throw new Error("store URL must not include a path");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")
      || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".invalid")) {
    throw new Error("store URL must use a public hostname");
  }
  // Literal IPs are unnecessary for storefronts and make an outbound scanner
  // an SSRF primitive. Hostnames remain subject to the Workers egress policy.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new Error("store URL must use a public hostname");
  }
  return `https://${host}`;
}

export function applyOfferLimit<T extends { id?: unknown }>(offers: T[], plan: PlanKey): { offers: T[]; limit: number; truncated: boolean } {
  const limit = offerLimitFor(plan);
  if (limit < 0) return { offers, limit, truncated: false };
  return { offers: offers.slice(0, limit), limit, truncated: offers.length > limit };
}
