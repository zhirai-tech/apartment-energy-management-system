import crypto from 'node:crypto';
import axios, { type AxiosRequestConfig } from 'axios';
import redis from '../../../lib/redis';
import { AppError } from '../../../lib/errors';
import {
  generateNonce,
  sha256Base64,
  hmacSha256Base64,
  toQueryString,
} from '../../../lib/crypto-helpers';
export { generateNonce, sha256Base64, hmacSha256Base64, toQueryString };

export type XiaomiSessionScope = 'main' | 'camera';

export interface XiaomiSession {
  userId: string;
  serviceToken: string;
  ssecurity: string;
  nonce?: number;
  username: string;
  loggedAt: string;
  region?: string;
}

export interface XiaomiAuthStatus {
  state: 'idle' | 'logged_in' | 'challenge_required' | 'error';
  needsVerification: boolean;
  verificationMethod?: 'browser' | 'email_code' | 'mobile_code' | null;
  message?: string;
  notificationUrl?: string;
  securityStatus?: number | null;
  pwd?: number | null;
  code?: number | string | null;
  location?: string | null;
  codeSentAt?: string | null;
  username?: string;
  lastAttemptAt?: string | null;
  region?: string | null;
  notificationId?: string | null;
  emailMask?: string | null;
  emailBound?: boolean | null;
  sendFailed?: boolean | null;
  rawSendBody?: unknown;
  rawIdentityListBody?: unknown;
  notificationList?: Array<unknown>;
}

export interface XiaomiCookieLoginInput {
  username?: string;
  userId: string;
  serviceToken: string;
  ssecurity: string;
  region?: string;
}

export interface XiaomiPendingLoginContext {
  username: string;
  cookieHeader: string;
  formData: Record<string, unknown>;
  notificationUrl?: string;
  context?: string;
  verificationMethod?: 'browser' | 'email_code' | null;
  codeSentAt?: string | null;
  lastAttemptAt: string;
  region?: string;
}

const SESSION_KEY_MAIN = 'xiaomi:session';
const SESSION_KEY_CAMERA = 'xiaomi:session:camera';
const AUTH_STATUS_KEY = 'xiaomi:auth-status';
const AUTH_STATUS_KEY_CAMERA = 'xiaomi:auth-status:camera';
const PENDING_LOGIN_KEY = 'xiaomi:pending-login';
const PENDING_LOGIN_KEY_CAMERA = 'xiaomi:pending-login:camera';
export const SESSION_TTL = 7 * 24 * 60 * 60;
export const REQUEST_TIMEOUT = 10000;
export const REGION_DEFAULT = 'cn';

const PASS_URL = 'https://account.xiaomi.com/pass/serviceLoginAuth2';
const SIGN_URL = 'https://account.xiaomi.com/pass/serviceLogin';
const DEVICE_LIST_URL = 'https://api.io.mi.com/home/device_list';

export function sessionKeyFor(scope: XiaomiSessionScope): string {
  return scope === 'camera' ? SESSION_KEY_CAMERA : SESSION_KEY_MAIN;
}

export function authStatusKeyFor(scope: XiaomiSessionScope): string {
  return scope === 'camera' ? AUTH_STATUS_KEY_CAMERA : AUTH_STATUS_KEY;
}

export function pendingLoginKeyFor(scope: XiaomiSessionScope): string {
  return scope === 'camera' ? PENDING_LOGIN_KEY_CAMERA : PENDING_LOGIN_KEY;
}

export function getEnvCredentials() {
  return {
    username: process.env.XIAOMI_USERNAME ?? '',
    password: process.env.XIAOMI_PASSWORD ?? '',
  };
}

export function getCameraEnvCredentials() {
  return {
    username: process.env.XIAOMI_CAMERA_USERNAME ?? process.env.XIAOMI_USERNAME ?? '',
    password: process.env.XIAOMI_CAMERA_PASSWORD ?? process.env.XIAOMI_PASSWORD ?? '',
  };
}

export function buildApiBaseUrl(region?: string): string {
  const normalized = (region || REGION_DEFAULT).toLowerCase();
  return normalized === 'cn'
    ? 'https://api.io.mi.com'
    : `https://${normalized}.api.io.mi.com`;
}

export function getDeviceListUrl(region?: string): string {
  const base = buildApiBaseUrl(region);
  return `${base}/home/device_list`;
}

export function mergeCookieHeader(base: string, append: string | string[] | undefined): string {
  if (!append) return base;
  const parts: string[] = [];
  if (base) parts.push(base);
  if (Array.isArray(append)) {
    for (const p of append) if (p) parts.push(p);
  } else if (typeof append === 'string' && append) {
    parts.push(append);
  }
  return parts.join('; ');
}

export function setCookieHeaderToMap(input?: string | string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const list = Array.isArray(input) ? input : [input];
  for (const line of list) {
    const arr = String(line || '').split(';');
    for (const item of arr) {
      const idx = item.indexOf('=');
      if (idx <= 0) continue;
      const k = item.slice(0, idx).trim();
      const v = item.slice(idx + 1).trim();
      if (k && !(k in out)) out[k] = v;
    }
  }
  return out;
}

export function cookieMapToHeader(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function stringifyLocation(header: string | string[] | undefined): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  try {
    return typeof raw === 'string' ? String(raw) : null;
  } catch {
    return typeof raw === 'string' ? raw : null;
  }
}

export async function readSessionFromRedis(
  scope: XiaomiSessionScope = 'main',
): Promise<XiaomiSession | null> {
  const raw = await redis.get(sessionKeyFor(scope));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XiaomiSession;
  } catch {
    return null;
  }
}

export async function writeSessionToRedis(
  session: XiaomiSession,
  scope: XiaomiSessionScope = 'main',
): Promise<void> {
  await redis.set(sessionKeyFor(scope), JSON.stringify(session), 'EX', SESSION_TTL);
}

export async function clearSessionInRedis(scope: XiaomiSessionScope = 'main'): Promise<void> {
  await redis.del(sessionKeyFor(scope));
}

export async function writePendingLoginToRedis(
  context: XiaomiPendingLoginContext,
  scope: XiaomiSessionScope = 'main',
): Promise<void> {
  await redis.set(pendingLoginKeyFor(scope), JSON.stringify(context), 'EX', 30 * 60);
}

export async function readPendingLoginFromRedis(
  scope: XiaomiSessionScope = 'main',
): Promise<XiaomiPendingLoginContext | null> {
  const raw = await redis.get(pendingLoginKeyFor(scope));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XiaomiPendingLoginContext;
  } catch {
    return null;
  }
}

export async function clearPendingLoginInRedis(
  scope: XiaomiSessionScope = 'main',
): Promise<void> {
  await redis.del(pendingLoginKeyFor(scope));
}

export async function writeAuthStatusToRedis(
  status: XiaomiAuthStatus,
  scope: XiaomiSessionScope = 'main',
): Promise<void> {
  await redis.set(authStatusKeyFor(scope), JSON.stringify(status), 'EX', SESSION_TTL);
}

export async function readAuthStatusFromRedis(
  scope: XiaomiSessionScope = 'main',
): Promise<XiaomiAuthStatus | null> {
  const raw = await redis.get(authStatusKeyFor(scope));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XiaomiAuthStatus;
  } catch {
    return null;
  }
}

export function buildSignedQueryNonce(ssecurity: string): { nonce: string; signedNonce: string } {
  const ssec = Buffer.from(ssecurity, 'base64');
  const nonce = generateNonce();
  const nonceBuf = Buffer.from(nonce, 'base64');
  const signedNonce = sha256Base64(Buffer.concat([ssec, nonceBuf]));
  return { nonce, signedNonce };
}

export function buildMiSignature(
  method: 'GET' | 'POST',
  path: string,
  signedNonce: string,
  nonce: string,
  params?: Record<string, unknown>,
  data?: Record<string, unknown>,
): string {
  const paramsQs = params ? toQueryString(params) : '';
  const bodyStr = data ? toQueryString(data) : '';
  const arr = [method.toUpperCase(), path, signedNonce, nonce];
  if (paramsQs) arr.push(paramsQs);
  if (bodyStr) arr.push(bodyStr);
  const message = arr.join('&');
  return hmacSha256Base64(Buffer.from(crypto.randomBytes(32)), message);
}

export function signAndBuildMiIoPayload(
  method: 'GET' | 'POST',
  path: string,
  ssecurity: string,
  nonceState: { nonce: string; signedNonce: string },
  params: Record<string, unknown> | undefined,
  data: Record<string, unknown> | undefined,
): { nonce: string; signature: string } {
  const paramsQs = params ? toQueryString(params) : '';
  const bodyStr = data ? toQueryString(data) : '';
  const message = [
    method.toUpperCase(),
    path,
    nonceState.signedNonce,
    nonceState.nonce,
    ...(paramsQs ? [paramsQs] : []),
    ...(bodyStr ? [bodyStr] : []),
  ].join('&');
  const signature = hmacSha256Base64(
    Buffer.concat([
      Buffer.from(ssecurity, 'base64'),
      Buffer.from(nonceState.nonce, 'base64'),
    ]),
    message,
  );
  return { nonce: nonceState.nonce, signature };
}

export { DEVICE_LIST_URL, SIGN_URL, PASS_URL };
export { axios, type AxiosRequestConfig, AppError };
