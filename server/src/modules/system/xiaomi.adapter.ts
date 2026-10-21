import crypto from 'node:crypto';
import { OperationType, DeviceStatus } from '@prisma/client';
import { XiaomiDeviceInfo, inferDeviceCategory, DeviceCategory } from '@shared/index';
import prisma from '../../lib/prisma';
import redis from '../../lib/redis';
import { writeOperation } from '../../lib/logger';
import { AppError } from '../../lib/errors';
import axios from 'axios';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  dayKeyToDate,
  getBusinessDate,
  getBusinessDayStartUtc,
  getDayKey,
} from '../../lib/business-time';
import { OperationActorContext } from '../../lib/operation-log';
import { formatRoomDisplayName } from '../../lib/room-display';
import {
  readSessionFromRedis,
  writeSessionToRedis,
  clearSessionInRedis,
  readPendingLoginFromRedis,
  writePendingLoginToRedis,
  clearPendingLoginInRedis,
  readAuthStatusFromRedis,
  writeAuthStatusToRedis,
  getEnvCredentials as getEnvCredentialsFromAuthLib,
  getCameraEnvCredentials,
  buildApiBaseUrl as buildApiBaseUrlFromLib,
  getDeviceListUrl,
  sessionKeyFor,
  authStatusKeyFor,
  pendingLoginKeyFor,
  REGION_DEFAULT,
  REQUEST_TIMEOUT,
  SIGN_URL,
  PASS_URL,
  type XiaomiSession,
  type XiaomiAuthStatus,
  type XiaomiSessionScope,
  type XiaomiCookieLoginInput,
  type XiaomiPendingLoginContext,
  mergeCookieHeader as mergeCookieHeaderFromLib,
  signAndBuildMiIoPayload,
  buildSignedQueryNonce,
  stringifyLocation,
  setCookieHeaderToMap,
  cookieMapToHeader,
  generateNonce,
  sha256Base64,
  hmacSha256Base64,
  SESSION_TTL,
} from './lib/xiaomi-auth';
import {
  type RawDevice,
  type MiotPropQueryItem,
  type DevicePropSnapshot,
  type PowerConfirmationOptions,
  type DeviceRuntimePrevious,
  sleep,
  buildMiotPropQueriesForDevice,
  parseDevicePropResponse,
  buildDeviceInfoItem,
  resolveRoomIdForDevice,
  assignFallbackRoomIds,
  syncXiaomiDevicesToDb,
  sanitizeRuntimeForUpsert,
  normalizeDeviceTelemetryValue,
} from './lib/xiaomi-devices';

function getEnvCredentials() {
  return getEnvCredentialsFromAuthLib();
}

const SIGN_SALT = 'XIAOMI-PROTOCAL-FLAG';
const DATA_PREFIX = 'data=';
const SERVICE_LOGIN_URL = 'https://account.xiaomi.com/pass/serviceLoginAuth2';
const SERVICE_LOGIN_PAGE = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_locale=zh_CN';
const SERVICE_LOGIN_PAGE_INTL = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiioo&_locale=en_US';
const CALLBACK_URL = 'https://sts.api.io.mi.com/sts';
const CALLBACK_URL_INTL = 'https://sts.api.io.mi.com/sts';
const DEVICE_LIST_URL = 'https://api.io.mi.com/app/home/device_list';
const GET_PROPS_URL = 'https://api.io.mi.com/app/device/batchreadprop';
const GET_PROPS_ALT = 'https://api.io.mi.com/app/device/getproperties';
const DEFAULT_LOCALE = 'zh_CN';
const DEFAULT_TIMEZONE = 'GMT+08:00';

function isIntlRegion(region?: string): boolean {
  return !!(region && region.toLowerCase() !== 'cn');
}

function resolveSsoBase(region?: string): {
  serviceLoginUrl: string;
  serviceLoginPage: string;
  callback: string;
  sid: string;
  locale: string;
  accountOrigin: string;
  identitySendUrl: string;
  identityVerifyUrl: string;
  identityCheckUrl: string;
  identityListUrl: string;
  appName: string;
} {
  if (isIntlRegion(region)) {
    return {
      serviceLoginUrl: SERVICE_LOGIN_URL,
      serviceLoginPage: 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_locale=en_US',
      callback: CALLBACK_URL,
      sid: 'xiaomiio',
      locale: 'en_US',
      accountOrigin: 'https://account.xiaomi.com',
      identityListUrl: 'https://account.xiaomi.com/identity/list',
      identitySendUrl: 'https://account.xiaomi.com/identity/auth/sendEmailTicket',
      identityVerifyUrl: 'https://account.xiaomi.com/identity/auth/verifyEmail',
      identityCheckUrl: 'https://account.xiaomi.com/identity/result/check',
      appName: 'com.xiaomi.smarthome.intl',
    };
  }
  return {
    serviceLoginUrl: SERVICE_LOGIN_URL,
    serviceLoginPage: SERVICE_LOGIN_PAGE,
    callback: CALLBACK_URL,
    sid: 'xiaomiio',
    locale: DEFAULT_LOCALE,
    accountOrigin: 'https://account.xiaomi.com',
    identityListUrl: 'https://account.xiaomi.com/identity/list',
    identitySendUrl: 'https://account.xiaomi.com/identity/auth/sendEmailTicket',
    identityVerifyUrl: 'https://account.xiaomi.com/identity/auth/verifyEmail',
    identityCheckUrl: 'https://account.xiaomi.com/identity/result/check',
    appName: 'com.xiaomi.smarthome',
  };
}

async function getBusinessTimeZoneSetting(): Promise<string> {
  const setting = await prisma.systemSettings.findUnique({
    where: { key: 'businessTimezone' },
    select: { value: true },
  });
  return setting?.value?.trim() || DEFAULT_BUSINESS_TIMEZONE;
}

async function getPricePerKwhSetting(): Promise<number> {
  const setting = await prisma.systemSettings.findUnique({
    where: { key: 'pricePerKwh' },
    select: { value: true },
  });
  const value = Number(setting?.value);
  return Number.isFinite(value) ? value : 0.58;
}

function buildApiBaseUrl(region?: string): string {
  return buildApiBaseUrlFromLib(region);
}

function mergeCookieHeader(
  baseCookieHeader: string,
  setCookieHeaders?: string[] | string,
): string {
  return mergeCookieHeaderFromLib(baseCookieHeader, setCookieHeaders);
}

function getCookieValue(cookieHeader: string, name: string): string {
  for (const part of String(cookieHeader || '').split(';')) {
    const item = part.trim();
    if (!item) continue;
    const eqIndex = item.indexOf('=');
    if (eqIndex <= 0) continue;
    if (item.slice(0, eqIndex) === name) {
      return item.slice(eqIndex + 1);
    }
  }
  return '';
}

function resolveRedirectUrl(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function inferRegionFromUrls(...urls: Array<string | null | undefined>): string | undefined {
  for (const url of urls) {
    const text = String(url ?? '').trim();
    if (!text) continue;
    const queryMatch = text.match(/[?&]region=([a-z0-9]{2,3})/i);
    if (queryMatch?.[1]) return queryMatch[1].toLowerCase();
    const hostMatch = text.match(/https:\/\/([a-z0-9]{2,3})\.api\.io\.mi\.com/i);
    if (hostMatch?.[1]) return hostMatch[1].toLowerCase();
  }
  return undefined;
}

function preferredChallengeVerificationMethod(
  scope: XiaomiSessionScope,
  region?: string,
): 'browser' | 'email_code' {
  if (scope === 'camera') return 'browser';
  if (isIntlRegion(region)) return 'browser';
  return 'email_code';
}

class XiaomiAdapter {
  private static instance: XiaomiAdapter | null = null;
  private lastRoomMap: Record<string, string | null> = {};
  private realtimeRefreshPromise: Promise<void> | null = null;
  private dailyHistorySyncPromise: Promise<void> | null = null;
  private lastDailyHistorySyncAt = 0;

  private constructor() {}

  public static getInstance(): XiaomiAdapter {
    if (!XiaomiAdapter.instance) {
      XiaomiAdapter.instance = new XiaomiAdapter();
    }
    return XiaomiAdapter.instance;
  }

  private async getSession(scope: XiaomiSessionScope = 'main'): Promise<XiaomiSession | null> {
    return readSessionFromRedis(scope);
  }

  public async peekSession(scope: XiaomiSessionScope = 'main'): Promise<XiaomiSession | null> {
    return this.getSession(scope);
  }

  private async setSession(session: XiaomiSession, scope: XiaomiSessionScope = 'main') {
    await writeSessionToRedis(session, scope);
  }

  private async setPendingLogin(context: XiaomiPendingLoginContext, scope: XiaomiSessionScope = 'main') {
    await writePendingLoginToRedis(context, scope);
  }

  private async getPendingLogin(scope: XiaomiSessionScope = 'main'): Promise<XiaomiPendingLoginContext | null> {
    return readPendingLoginFromRedis(scope);
  }

  private async clearPendingLogin(scope: XiaomiSessionScope = 'main') {
    await clearPendingLoginInRedis(scope);
  }

  private async setAuthStatus(status: XiaomiAuthStatus, scope: XiaomiSessionScope = 'main') {
    await writeAuthStatusToRedis(status, scope);
  }

  public async getAuthStatus(scope: XiaomiSessionScope = 'main'): Promise<XiaomiAuthStatus | null> {
    return readAuthStatusFromRedis(scope);
  }

  public async isLoggedIn(scope: XiaomiSessionScope = 'main'): Promise<boolean> {
    const session = await this.getSession(scope);
    return !!(session && !/^mock_/.test(session.serviceToken));
  }

  public async login(
    usernameInput?: string,
    passwordInput?: string,
    scope: XiaomiSessionScope = 'main',
    regionInput?: string,
  ): Promise<boolean> {
    const env = scope === 'camera'
      ? {
          username: process.env.XIAOMI_CAMERA_USERNAME ?? '',
          password: process.env.XIAOMI_CAMERA_PASSWORD ?? '',
        }
      : getEnvCredentials();
    const username = usernameInput || env.username;
    const password = passwordInput || env.password;
    if (!username || !password) {
      throw new Error(`缺少米家${scope === 'camera' ? '欧洲区' : ''}账号或密码（请在${scope === 'camera' ? '欧洲区登录卡片里输入账号密码，或配置 XIAOMI_CAMERA_USERNAME/XIAOMI_CAMERA_PASSWORD' : '环境变量 XIAOMI_USERNAME/XIAOMI_PASSWORD 中配置'}）`);
    }
    const region = regionInput?.trim() || (scope === 'camera' ? 'de' : REGION_DEFAULT);

    await redis.del(sessionKeyFor(scope));
    await this.clearPendingLogin(scope);
    await this.setAuthStatus({
      state: 'idle',
      needsVerification: false,
      verificationMethod: null,
      message: `正在尝试登录米家${scope === 'camera' ? '摄像头区' : ''}账号`,
      username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);
    const session = await this.tryLoginAccount(username, password, scope, region);
    await this.setSession(session, scope);
    await this.setAuthStatus({
      state: 'logged_in',
      needsVerification: false,
      verificationMethod: null,
      message: `米家${scope === 'camera' ? '摄像头区' : ''}账号登录成功`,
      username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);
    return true;
  }

  public async loginWithSession(
    input: XiaomiCookieLoginInput,
    scope: XiaomiSessionScope = 'main',
  ): Promise<boolean> {
    const userId = input.userId?.trim();
    const serviceToken = input.serviceToken?.trim();
    const ssecurity = input.ssecurity?.trim();
    const username = input.username?.trim() || 'cookie_session';
    const region = input.region?.trim() || (scope === 'camera' ? 'de' : REGION_DEFAULT);

    if (!userId || !serviceToken || !ssecurity) {
      throw new Error('缺少 userId / serviceToken / ssecurity，无法建立米家会话');
    }

    await redis.del(sessionKeyFor(scope));
    await this.clearPendingLogin(scope);
    await this.setAuthStatus({
      state: 'idle',
      needsVerification: false,
      message: `正在使用会话串登录米家${scope === 'camera' ? '摄像头区' : ''}账号`,
      username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);

    const session: XiaomiSession = {
      userId,
      serviceToken,
      ssecurity,
      username,
      region,
      loggedAt: new Date().toISOString(),
    };

    await this.verifySession(session);
    await this.setSession(session, scope);
    await this.setAuthStatus({
      state: 'logged_in',
      needsVerification: false,
      verificationMethod: null,
      message: `米家${scope === 'camera' ? '摄像头区' : ''}会话串登录成功`,
      username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);
    return true;
  }

  private async getWithCookieContext(
    url: string,
    cookieHeader: string,
    options?: {
      params?: Record<string, any>;
      referer?: string;
      allowRedirects?: boolean;
    },
  ) {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: options?.allowRedirects === false ? 0 : 10,
      validateStatus: (s: number) => s >= 200 && s < 400,
      headers: {
        Cookie: cookieHeader,
        Referer: options?.referer || 'https://account.xiaomi.com/',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 11 Build/SKQ1.211019.001) APP/com.xiaomi.smarthome APPV/7.0.0',
      },
      params: options?.params,
    });

    return {
      response,
      cookieHeader: mergeCookieHeader(cookieHeader, response.headers['set-cookie']),
    };
  }

  private async postFormWithCookieContext(
    url: string,
    cookieHeader: string,
    data: Record<string, any>,
    options?: {
      params?: Record<string, any>;
      referer?: string;
      origin?: string;
    },
  ) {
    const response = await axios.postForm(url, data, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 0,
      validateStatus: (s: number) => s >= 200 && s < 400,
      headers: {
        Cookie: cookieHeader,
        Origin: options?.origin || 'https://account.xiaomi.com',
        Referer: options?.referer || 'https://account.xiaomi.com/',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 11 Build/SKQ1.211019.001) APP/com.xiaomi.smarthome APPV/7.0.0',
      },
      params: options?.params,
    });

    return {
      response,
      cookieHeader: mergeCookieHeader(cookieHeader, response.headers['set-cookie']),
    };
  }

  private async followRedirectsWithCookies(url: string, cookieHeader: string) {
    let currentUrl = url;
    let currentCookieHeader = cookieHeader;
    let response: any = null;

    for (let hop = 0; hop < 8; hop += 1) {
      const result = await this.getWithCookieContext(currentUrl, currentCookieHeader, {
        allowRedirects: false,
      });
      response = result.response;
      currentCookieHeader = result.cookieHeader;

      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        currentUrl = resolveRedirectUrl(response.headers.location, currentUrl);
        continue;
      }
      return {
        response,
        cookieHeader: currentCookieHeader,
        finalUrl: currentUrl,
      };
    }

    throw new Error('米家 STS 跳转次数过多');
  }

  public async sendEmailVerificationCode(scope: XiaomiSessionScope = 'main'): Promise<boolean> {
    const pending = await this.getPendingLogin(scope);
    if (!pending?.notificationUrl) {
      throw new Error('没有待完成的米家邮箱验证，请先重新登录');
    }

    const context =
      pending.context ||
      (() => {
        try {
          return new URL(pending.notificationUrl || '').searchParams.get('context') || '';
        } catch {
          return '';
        }
      })();

    if (!context) {
      throw new Error('米家验证上下文缺失，无法发送邮箱验证码');
    }

    const sso = resolveSsoBase(pending.region);

    let cookieHeader = pending.cookieHeader;

    console.info('[XiaomiAdapter.sendEmailVerificationCode] 开始：', {
      scope,
      region: pending.region,
      username: pending.username,
      notificationUrl: pending.notificationUrl,
      context,
      sso: {
        serviceLoginPage: sso.serviceLoginPage,
        identityListUrl: sso.identityListUrl,
        identitySendUrl: sso.identitySendUrl,
        sid: sso.sid,
        locale: sso.locale,
        accountOrigin: sso.accountOrigin,
      },
    });

    const authStartResult = await this.getWithCookieContext(pending.notificationUrl, cookieHeader, {
      referer: sso.serviceLoginPage,
    });
    cookieHeader = authStartResult.cookieHeader;
    console.info('[XiaomiAdapter.sendEmailVerificationCode] authStart (notificationUrl GET)：', {
      status: authStartResult.response.status,
      location: (authStartResult.response.headers as any)?.location ?? null,
      hasIck: !!getCookieValue(cookieHeader, 'ick'),
      hasPassToken: !!getCookieValue(cookieHeader, 'passToken'),
      cookieHead: cookieHeader.slice(0, 260),
      bodyHead: typeof authStartResult.response.data === 'string'
        ? authStartResult.response.data.slice(0, 400)
        : JSON.stringify(authStartResult.response.data ?? {}).slice(0, 400),
    });

    const listResult = await this.getWithCookieContext(
      sso.identityListUrl,
      cookieHeader,
      {
        params: {
          sid: sso.sid,
          context,
          _locale: sso.locale,
        },
      },
    );
    cookieHeader = listResult.cookieHeader;
    const listRawRaw = typeof listResult.response.data === 'string'
      ? listResult.response.data
      : JSON.stringify(listResult.response.data ?? {});
    console.info('[XiaomiAdapter.sendEmailVerificationCode] identityList 返回：', {
      status: listResult.response.status,
      url: sso.identityListUrl,
      params: { sid: sso.sid, context, _locale: sso.locale },
      bodyHead: listRawRaw.slice(0, 1500),
    });

    let listPayload: any = null;
    try { listPayload = typeof listResult.response.data === 'string' ? JSON.parse(listResult.response.data.replace(/^&&&START&&&/, '')) : listResult.response.data; } catch {}
    const candidates: any[] = [];
    if (listPayload && typeof listPayload === 'object') {
      if (Array.isArray(listPayload.notifications)) candidates.push(...listPayload.notifications);
      if (Array.isArray((listPayload as any).notificationList)) candidates.push(...((listPayload as any).notificationList));
      if (Array.isArray((listPayload as any).data?.notifications)) candidates.push(...((listPayload as any).data.notifications));
      if (Array.isArray((listPayload as any).result?.notifications)) candidates.push(...((listPayload as any).result.notifications));
      if (Array.isArray((listPayload as any).data?.notificationList)) candidates.push(...((listPayload as any).data.notificationList));
      if (Array.isArray((listPayload as any).result?.notificationList)) candidates.push(...((listPayload as any).result.notificationList));
    }
    const notificationIds: string[] = [];
    const notificationDetails: Array<{ id: string; type: string; detail: string; method: string; via: string; channel: string }> = [];
    let emailMask: string | null = null;
    let listHasEmail = false;
    let listHasMobile = false;
    let preferredNotification: any = null;
    for (const n of candidates) {
      if (!n || typeof n !== 'object') continue;
      const id = String(n.notificationId ?? n.id ?? n.ticket ?? n.identityId ?? '').trim();
      const detail = String(n.detail ?? n.displayName ?? n.phone ?? n.email ?? n.credential ?? n.mask ?? n.title ?? '').trim();
      const type = String(n.type ?? n.channel ?? n.method ?? n.via ?? n.kind ?? '').toLowerCase();
      const methodRaw = String(n.method ?? n.notificationMethod ?? n.notifyMethod ?? n.sendMethod ?? '').toLowerCase();
      const viaRaw = String(n.via ?? n.sendVia ?? n.route ?? '').toLowerCase();
      const channelRaw = String(n.channel ?? n.notificationChannel ?? '').toLowerCase();
      if (id) notificationIds.push(id);
      notificationDetails.push({ id, type, detail, method: methodRaw, via: viaRaw, channel: channelRaw });
      const isEmail =
        detail.includes('@') ||
        type.includes('mail') ||
        methodRaw.includes('mail') ||
        viaRaw.includes('mail') ||
        channelRaw.includes('mail') ||
        String(n.kind ?? '').toLowerCase().includes('mail') ||
        String(n.category ?? '').toLowerCase().includes('mail') ||
        (id.toLowerCase().includes('mail') && detail);
      const isMobile =
        !isEmail &&
        (type.includes('mobile') ||
          type.includes('sms') ||
          type.includes('phone') ||
          methodRaw.includes('mobile') ||
          methodRaw.includes('sms') ||
          viaRaw.includes('sms') ||
          viaRaw.includes('mobile') ||
          channelRaw.includes('sms') ||
          channelRaw.includes('mobile') ||
          /^[+\-\s\(\)\d]+$/.test(detail.replace(/\s+/g, '')));
      if (isEmail && !listHasEmail) {
        listHasEmail = true;
        emailMask = detail;
        preferredNotification = n;
      }
      if (isMobile) {
        listHasMobile = true;
        if (!preferredNotification) preferredNotification = n;
      }
    }
    console.info('[XiaomiAdapter.sendEmailVerificationCode] identityList 解析：', {
      totalNotifications: candidates.length,
      notificationIds,
      notificationDetails,
      listHasEmail,
      listHasMobile,
      emailMask,
      preferredNotificationId: preferredNotification ? String(preferredNotification.notificationId ?? preferredNotification.id ?? '').trim() : null,
      listKeys: listPayload && typeof listPayload === 'object' ? Object.keys(listPayload) : null,
    });

    const v2DirectVerify =
      listPayload && typeof listPayload === 'object' && (
        (listPayload as any).directVerify === true ||
        (listPayload as any).code === 2 ||
        String((listPayload as any).retrieveType ?? '').toLowerCase() === 'bind' ||
        (Number((listPayload as any).flag ?? 0) & 8) === 8
      ) ? true : false;
    if (v2DirectVerify && !listHasEmail && !listHasMobile) {
      listHasEmail = true;
      emailMask = pending.username?.includes('@') ? pending.username : emailMask || '绑定安全邮箱';
      console.info('[XiaomiAdapter.sendEmailVerificationCode] 触发 EU v2 directVerify=true（retrieveType=bind, code=2, flag=8，直接发邮箱验证（无需 identity/notifications）。');
    }

    const writeAuthDiagnosis = async (extra: Partial<XiaomiAuthStatus>) => {
      await this.setAuthStatus(
        {
          state: 'challenge_required',
          needsVerification: true,
          verificationMethod: listHasEmail ? 'email_code' : listHasMobile ? 'mobile_code' : null,
          message: extra?.message ?? '请完成验证',
          notificationUrl: pending.notificationUrl,
          securityStatus: 16,
          username: pending.username,
          lastAttemptAt: new Date().toISOString(),
          rawIdentityListBody: listPayload ?? listResult.response.data ?? null,
          notificationList: candidates.length ? candidates : undefined,
          ...extra,
        },
        scope,
      );
    };

    if (!listHasEmail && !listHasMobile) {
      await writeAuthDiagnosis({
        emailBound: false,
        message:
          '该 EU 米家账号当前未启用可用的验证通知方式。请在手机米家 APP（或 account.xiaomi.com → 登录与安全）里绑定邮箱/手机号为二次验证方式，或先从米家官方 APP 登录 EU 区设备一次激活验证方式后再回来重试。（identity/list 无可用 email/sms 渠道）',
      });
      throw new Error(
        '未找到可用的 EU 账号验证方式（identity/list 返回的通知渠道里既没有 email 也没有手机 sms）。请先到 account.xiaomi.com → 登录与安全 里绑定/启用邮箱或手机号为验证方式后再试。',
      );
    }
    const useMethod: 'email' | 'mobile' = listHasEmail ? 'email' : 'mobile';
    const chosenId: string =
      (preferredNotification ? String(preferredNotification.notificationId ?? preferredNotification.id ?? '').trim() : '') ||
      notificationIds[0] ||
      '';
    const identitySendUrl: string =
      useMethod === 'email' ? sso.identitySendUrl : sso.identitySendUrl.replace('/sendEmailTicket', '/sendMobileTicket').replace('/auth/sendEmailTicket', '/auth/sendMobileTicket');
    if (useMethod === 'mobile') {
      console.warn('[XiaomiAdapter.sendEmailVerificationCode] 没有 email 渠道，回退为短信（mobile_code）验证，目标 URL =', identitySendUrl);
    }

    const sendResult = await this.postFormWithCookieContext(
      identitySendUrl,
      cookieHeader,
      {
        _flag: String(useMethod === 'email' ? '8' : useMethod === 'mobile' ? '4' : '8'),
        retry: '0',
        icode: '',
        _json: 'true',
        ick: getCookieValue(cookieHeader, 'ick'),
        ...(chosenId ? { notificationId: chosenId } : {}),
      },
      {
        params: {
          _dc: String(Date.now()),
          sid: sso.sid,
          context,
          mask: '0',
          _locale: sso.locale,
        },
        origin: sso.accountOrigin,
        referer: sso.accountOrigin + '/',
      },
    );
    cookieHeader = sendResult.cookieHeader;

    let payload: any = null;
    try {
      const raw = typeof sendResult.response.data === 'string'
        ? sendResult.response.data.replace(/^&&&START&&&/, '')
        : sendResult.response.data;
      payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      payload = null;
    }

    console.info('[XiaomiAdapter.sendEmailVerificationCode] identitySend 返回：', {
      status: sendResult.response.status,
      url: identitySendUrl,
      useMethod,
      chosenId,
      sendBody: { retry: '0', icode: '', _json: 'true', ick: getCookieValue(cookieHeader, 'ick'), ...(chosenId ? { notificationId: chosenId } : {}) },
      sendParams: { _dc: String(Date.now()), sid: sso.sid, context, mask: '0', _locale: sso.locale },
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
      bodyFull: payload ? JSON.stringify(payload).slice(0, 2000) : (typeof sendResult.response.data === 'string' ? sendResult.response.data.slice(0, 2000) : JSON.stringify(sendResult.response.data ?? '').slice(0, 2000)),
    });

    const sendOk =
      (payload && typeof payload === 'object' && (payload.result === 'ok' || payload.code === 0 || payload.status === 0 || (payload.notificationId && payload.sent !== false)))
        ? true
        : (sendResult.response.status >= 200 && sendResult.response.status < 400 && !(payload && typeof payload === 'object' && (payload.code && payload.code !== 0 || payload.result === 'error')));
    if (!sendOk) {
      const msg = payload && typeof payload === 'object'
        ? (String([payload?.tips, payload?.desc, payload?.description, payload?.message, payload?.title, payload?.action].filter(Boolean).join(' · ') || '').trim() || `${useMethod === 'email' ? 'identity/sendEmailTicket' : 'identity/sendMobileTicket'} 拒绝，code=${String(payload.code ?? 'unknown')}`)
        : `${useMethod === 'email' ? 'identity/sendEmailTicket' : 'identity/sendMobileTicket'} HTTP ${sendResult.response.status}`;
      await this.setAuthStatus({
        state: 'error',
        needsVerification: true,
        verificationMethod: useMethod === 'email' ? 'email_code' : 'mobile_code',
        message: msg,
        notificationUrl: pending.notificationUrl,
        securityStatus: 16,
        username: pending.username,
        sendFailed: true,
        lastAttemptAt: new Date().toISOString(),
        rawSendBody: payload ?? null,
        rawIdentityListBody: listPayload ?? listResult.response.data ?? null,
        notificationList: candidates.length ? candidates : undefined,
      }, scope);
      throw new Error(msg);
    }

    const codeSentAt = new Date().toISOString();
    await this.setPendingLogin({
      ...pending,
      cookieHeader,
      context,
      verificationMethod: useMethod === 'email' ? 'email_code' : 'mobile_code',
      codeSentAt,
      lastAttemptAt: codeSentAt,
      notificationId: chosenId ?? (pending as any).notificationId ?? undefined,
      emailMask,
    } as any, scope);

    await this.setAuthStatus({
      state: 'challenge_required',
      needsVerification: true,
      verificationMethod: useMethod === 'email' ? 'email_code' : 'mobile_code',
      message: useMethod === 'email' ? `验证码已发送至邮箱 ${emailMask ?? ''}，请查收并输入` : `验证码已通过短信发送至 ${chosenId}，请查收并输入`,
      notificationUrl: pending.notificationUrl,
      securityStatus: 16,
      username: pending.username,
      notificationId: chosenId ?? undefined,
      emailMask,
      emailBound: useMethod === 'email',
      codeSentAt,
      lastAttemptAt: codeSentAt,
      rawIdentityListBody: listPayload ?? listResult.response.data ?? null,
      notificationList: candidates.length ? candidates : undefined,
    }, scope);

    return true;
  }

  public async verifyEmailCode(code: string, scope: XiaomiSessionScope = 'main'): Promise<boolean> {
    const pending = await this.getPendingLogin(scope);
    const verificationCode = code.trim();
    if (!pending?.notificationUrl) {
      throw new Error('没有待完成的米家邮箱验证，请先重新登录');
    }
    if (!verificationCode) {
      throw new Error('请输入邮箱验证码');
    }

    const context =
      pending.context ||
      (() => {
        try {
          return new URL(pending.notificationUrl || '').searchParams.get('context') || '';
        } catch {
          return '';
        }
      })();

    if (!context) {
      throw new Error('米家验证上下文缺失，无法校验邮箱验证码');
    }

    const pendingRegion = pending.region?.trim() || (scope === 'camera' ? 'de' : REGION_DEFAULT);
    const sso = resolveSsoBase(pendingRegion);

    let cookieHeader = pending.cookieHeader;
    const verifyResult = await this.postFormWithCookieContext(
      sso.identityVerifyUrl,
      cookieHeader,
      {
        _flag: '8',
        ticket: verificationCode,
        trust: 'false',
        _json: 'true',
        ick: getCookieValue(cookieHeader, 'ick'),
      },
      {
        params: {
          _flag: '8',
          _json: 'true',
          sid: sso.sid,
          context,
          mask: '0',
          _locale: sso.locale,
        },
        origin: sso.accountOrigin,
        referer: sso.accountOrigin + '/',
      },
    );
    cookieHeader = verifyResult.cookieHeader;

    let finishLocation = '';
    try {
      const payload =
        typeof verifyResult.response.data === 'string'
          ? JSON.parse(verifyResult.response.data)
          : verifyResult.response.data;
      finishLocation = payload?.location || '';
    } catch {
      const locationHeader = verifyResult.response.headers.location;
      if (locationHeader) {
        finishLocation = locationHeader;
      } else if (typeof verifyResult.response.data === 'string') {
        const intlMatch = verifyResult.response.data.match(/https:\/\/account\.io\.mi\.com\/identity\/result\/check\?[^"'\s]+/);
        if (intlMatch) finishLocation = intlMatch[0];
        const cnMatch = verifyResult.response.data.match(/https:\/\/account\.xiaomi\.com\/identity\/result\/check\?[^"'\s]+/);
        if (!finishLocation && cnMatch) finishLocation = cnMatch[0];
      }
    }

    if (!finishLocation) {
      const fallback = await this.getWithCookieContext(
        sso.identityCheckUrl,
        cookieHeader,
        {
          params: {
            sid: sso.sid,
            context,
            _locale: sso.locale,
          },
          allowRedirects: false,
          referer: sso.accountOrigin + '/',
        },
      );
      cookieHeader = fallback.cookieHeader;
      if (fallback.response.headers.location) {
        finishLocation = fallback.response.headers.location;
      }
    }

    if (!finishLocation) {
      throw new Error('米家未返回验证码完成跳转地址');
    }

    let endUrl = finishLocation;
    if (finishLocation.includes('identity/result/check')) {
      const finishResult = await this.getWithCookieContext(finishLocation, cookieHeader, {
        allowRedirects: false,
      });
      cookieHeader = finishResult.cookieHeader;
      endUrl = finishResult.response.headers.location || '';
    }

    if (!endUrl) {
      throw new Error('米家未返回 Auth2/end 地址');
    }

    let endResult = await this.getWithCookieContext(endUrl, cookieHeader, {
      allowRedirects: false,
    });
    cookieHeader = endResult.cookieHeader;
    if (
      endResult.response.status === 200 &&
      typeof endResult.response.data === 'string' &&
      endResult.response.data.includes('Xiaomi Account - Tips')
    ) {
      endResult = await this.getWithCookieContext(endUrl, cookieHeader, {
        allowRedirects: false,
      });
      cookieHeader = endResult.cookieHeader;
    }

    let ssecurity = '';
    const extensionPragma = endResult.response.headers['extension-pragma'];
    if (extensionPragma) {
      try {
        const payload = JSON.parse(extensionPragma);
        ssecurity = payload?.ssecurity || '';
      } catch {
        ssecurity = '';
      }
    }
    if (!ssecurity) {
      throw new Error('米家未返回 ssecurity，无法完成登录');
    }

    let stsUrl = endResult.response.headers.location || '';
    if (!stsUrl && typeof endResult.response.data === 'string') {
      const match = endResult.response.data.match(/https:\/\/sts\.api\.io\.mi\.com\/sts[^"'\s]*/);
      stsUrl = match?.[0] || '';
    }
    if (!stsUrl) {
      throw new Error('米家未返回 STS 跳转地址');
    }

    const stsResult = await this.followRedirectsWithCookies(stsUrl, cookieHeader);
    cookieHeader = stsResult.cookieHeader;

    const serviceToken = decodeURIComponent(getCookieValue(cookieHeader, 'serviceToken') || '');
    const userId =
      decodeURIComponent(getCookieValue(cookieHeader, 'userId') || '') ||
      decodeURIComponent(getCookieValue(cookieHeader, 'cUserId') || '');

    if (!serviceToken) {
      throw new Error('米家未返回 serviceToken，无法完成登录');
    }
    if (!userId) {
      throw new Error('米家未返回 userId，无法完成登录');
    }

    const inferredRegion =
      inferRegionFromUrls(finishLocation, endUrl, stsUrl, stsResult.finalUrl) || pendingRegion;

    const session: XiaomiSession = {
      userId,
      serviceToken,
      ssecurity,
      username: pending.username,
      region: inferredRegion,
      loggedAt: new Date().toISOString(),
    };

    try {
      await this.verifySession(session);
      await this.setSession(session, scope);
      await this.clearPendingLogin(scope);
      await this.setAuthStatus({
        state: 'logged_in',
        needsVerification: false,
        verificationMethod: null,
        message: '米家账号登录成功',
        username: pending.username,
        codeSentAt: null,
        region: inferredRegion,
        lastAttemptAt: new Date().toISOString(),
      }, scope);
      return true;
    } catch (err: any) {
      await this.setAuthStatus({
        state: 'error',
        needsVerification: true,
        verificationMethod: 'email_code',
        message: err?.message || '米家验证码校验后会话验证失败',
        username: pending.username,
        codeSentAt: pending.codeSentAt || null,
        region: inferredRegion,
        lastAttemptAt: new Date().toISOString(),
      }, scope);
      throw err;
    }
  }

  public async continueLogin(scope: XiaomiSessionScope = 'main'): Promise<boolean> {
    const pending = await this.getPendingLogin(scope);
    // #region debug-point B:adapter-continue-pending
    (() => {
      const fs = require('node:fs');
      let u = 'http://145.223.100.249:7777/event';
      let s = 'xiaomi-auto-login';
      try {
        const e = fs.readFileSync('.dbg/xiaomi-auto-login.env', 'utf8');
        u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
        s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
      } catch {}
      fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: s,
          runId: 'pre-fix',
          hypothesisId: 'B',
          location: 'xiaomi.adapter.ts:continueLogin:pending',
          msg: '[DEBUG] continue login loaded pending context',
          data: {
            hasPending: !!pending,
            username: pending?.username ?? null,
            hasNotificationUrl: !!pending?.notificationUrl,
            cookieHeaderLength: pending?.cookieHeader?.length ?? 0,
            formDataKeys: pending ? Object.keys(pending.formData ?? {}).sort() : [],
            lastAttemptAt: pending?.lastAttemptAt ?? null,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion
    if (!pending) {
      throw new Error('没有待完成的米家安全验证，请重新点击登录');
    }

    await this.setAuthStatus({
      state: 'idle',
      needsVerification: true,
      message: '正在继续完成米家安全验证登录',
      notificationUrl: pending.notificationUrl,
      username: pending.username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);

    const session = await this.loginHttpWithContext(
      pending.username,
      pending.cookieHeader,
      pending.formData,
      scope,
      pending.region,
    );
    await this.setSession(session, scope);
    await this.clearPendingLogin(scope);
    await this.setAuthStatus({
      state: 'logged_in',
      needsVerification: false,
      message: '米家账号登录成功',
      username: pending.username,
      lastAttemptAt: new Date().toISOString(),
    }, scope);
    return true;
  }

  private async tryLoginAccount(
    username: string,
    password: string,
    scope: XiaomiSessionScope = 'main',
    region?: string,
  ): Promise<XiaomiSession> {
    try {
      return await this.loginHttp(username, password, scope, region);
    } catch (httpErr: any) {
      console.error('[XiaomiAdapter] 真实米家登录失败：', httpErr?.message || httpErr, httpErr?.stack ?? '');
      throw new Error(httpErr?.message || '米家真实登录失败');
    }
  }

  private async loginHttp(
    username: string,
    password: string,
    scope: XiaomiSessionScope = 'main',
    region?: string,
  ): Promise<XiaomiSession> {
    const hashPwd = crypto.createHash('md5').update(password, 'utf8').digest('hex').toUpperCase();
    const scopeDefault = scope === 'camera' ? 'de' : REGION_DEFAULT;
    const effectiveRegion = (region?.trim().toLowerCase()) || scopeDefault;
    const sso = resolveSsoBase(effectiveRegion);
    const _json = 'true';
    console.debug('[XiaomiAdapter] step0 获取 serviceLogin _sign');
    const step0Resp = await axios.get(sso.serviceLoginPage, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 0,
      validateStatus: (s: number) => s >= 200 && s < 400,
      headers: {
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 11 Build/SKQ1.211019.001) APP/com.xiaomi.smarthome APPV/7.0.0',
        Accept: 'application/json',
      },
      params: { sid: sso.sid, _json, _locale: sso.locale },
    });
    const rawStep0 = step0Resp.data?.startsWith?.('&&&START&&&') ? step0Resp.data.slice('&&&START&&&'.length) : step0Resp.data;
    let step0Payload: any = {};
    try { step0Payload = typeof rawStep0 === 'string' ? JSON.parse(rawStep0) : (rawStep0 ?? {}); } catch { /* ignore */ }
    const _sign = step0Payload?._sign ?? '';
    const qs = encodeURIComponent(`?sid=${sso.sid}&_locale=${encodeURIComponent(sso.locale)}&_json=${_json}`);

    const cookies: string[] = [];
    const setCookie = step0Resp.headers['set-cookie'];
    if (Array.isArray(setCookie)) {
      for (const c of setCookie) {
        const part = c.split(';')[0];
        if (part && part.includes('=')) cookies.push(part);
      }
    }
    const deviceId =
      (cookies.find((c) => c.startsWith('deviceId=')) || '').split('=')[1] ||
      Buffer.from(crypto.randomBytes(8)).toString('hex');
    cookies.push(`deviceId=${deviceId}`);
    cookies.push(`sdkVersion=accountsdk-18.8.15`);
    const cookieHeader = cookies.join('; ');
    console.debug('[XiaomiAdapter] step1 cookie count=', cookies.length, '_sign len=', String(_sign).length, 'sso.locale=', sso.locale);

    const data: Record<string, any> = {
      _json,
      sid: sso.sid,
      callback: sso.callback,
      locale: sso.locale,
      _locale: sso.locale,
      user: username,
      hash: hashPwd,
      _sign,
      qs,
    };

    return this.loginHttpWithContext(username, cookieHeader, data, scope, region);
  }

  private async loginHttpWithContext(
    username: string,
    cookieHeader: string,
    data: Record<string, any>,
    scope: XiaomiSessionScope = 'main',
    regionInput?: string,
  ): Promise<XiaomiSession> {
    const scopeDefault2 = scope === 'camera' ? 'de' : REGION_DEFAULT;
    const effectiveRegion2 = (regionInput?.trim().toLowerCase()) || scopeDefault2;
    const sso2 = resolveSsoBase(effectiveRegion2);
    const challengeVerificationMethod = preferredChallengeVerificationMethod(scope, effectiveRegion2);
    console.debug('[XiaomiAdapter] step2 调用 serviceLoginAuth2 账密校验', {
      user: username,
      sid: data.sid,
      callback: data.callback,
      ssoLoginUrl: sso2.serviceLoginUrl,
      effectiveRegion: effectiveRegion2,
    });
    const loginResp = await axios.postForm<string>(sso2.serviceLoginUrl, data, {
      timeout: REQUEST_TIMEOUT,
      validateStatus: (s: number) => s >= 200 && s < 500,
      headers: {
        Cookie: cookieHeader,
        Origin: sso2.accountOrigin,
        Referer: sso2.serviceLoginPage,
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 11 Build/SKQ1.211019.001) APP/com.xiaomi.smarthome APPV/7.0.0',
      },
    });
    console.debug('[XiaomiAdapter] step2 status=', loginResp.status, 'len=', (loginResp.data ?? '').length);
    const loginSetCookie = loginResp.headers['set-cookie'];
    const nextCookieHeader = mergeCookieHeader(cookieHeader, loginSetCookie);

    const raw = loginResp.data?.startsWith?.('&&&START&&&') ? loginResp.data.slice('&&&START&&&'.length) : loginResp.data;
    let payload: any = null;
    try { payload = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {}); } catch (parseErr: any) { console.error('[XiaomiAdapter] 解析登录响应 JSON 失败 snippet=', String(raw).slice(0, 600), parseErr?.message ?? ''); }
    console.debug('[XiaomiAdapter] step2 解析结果 payload keys=', Object.keys(payload ?? {}).slice(0, 30).join(','));
    // #region debug-point C:adapter-password-payload
    (() => {
      const fs = require('node:fs');
      let u = 'http://127.0.0.1:7777/event';
      let s = 'xiaomi-login-still-fails';
      try {
        const e = fs.readFileSync('.dbg/xiaomi-login-still-fails.env', 'utf8');
        u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
        s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
      } catch {}
      fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: s,
          runId: 'pre-fix',
          hypothesisId: 'C',
          location: 'xiaomi.adapter.ts:loginHttp:payload',
          msg: '[DEBUG] password login payload parsed',
          data: {
            result: payload?.result ?? null,
            code: payload?.code ?? null,
            hasNotificationUrl: !!payload?.notificationUrl,
            securityStatus: payload?.securityStatus ?? null,
            hasUserId: !!payload?.userId,
            hasSsecurity: !!payload?.ssecurity,
            hasLocation: !!payload?.location,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion
    // #region debug-point C:adapter-auto-login-payload
    (() => {
      const fs = require('node:fs');
      let u = 'http://145.223.100.249:7777/event';
      let s = 'xiaomi-auto-login';
      try {
        const e = fs.readFileSync('.dbg/xiaomi-auto-login.env', 'utf8');
        u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
        s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
      } catch {}
      fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: s,
          runId: 'pre-fix',
          hypothesisId: 'C',
          location: 'xiaomi.adapter.ts:loginHttpWithContext:payload',
          msg: '[DEBUG] auto login payload parsed',
          data: {
            result: payload?.result ?? null,
            code: payload?.code ?? null,
            desc: payload?.desc ?? payload?.description ?? payload?.message ?? null,
            hasNotificationUrl: !!payload?.notificationUrl,
            securityStatus: payload?.securityStatus ?? null,
            hasUserId: !!payload?.userId,
            hasSsecurity: !!payload?.ssecurity,
            hasLocation: !!payload?.location,
            locationPreview: typeof payload?.location === 'string' ? String(payload.location).slice(0, 120) : null,
            nextCookieHeaderLength: nextCookieHeader.length,
            loginSetCookieCount: Array.isArray(loginSetCookie) ? loginSetCookie.length : 0,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion
    if (!payload || payload.result !== 'ok') {
      const code = payload?.code ?? 'UNKNOWN';
      const msg = payload?.desc ?? payload?.description ?? payload?.message ?? '登录失败';
      await this.setAuthStatus({
        state: payload?.notificationUrl ? 'challenge_required' : 'error',
        needsVerification: !!payload?.notificationUrl,
        message: msg,
        notificationUrl: payload?.notificationUrl,
        securityStatus: payload?.securityStatus ?? null,
        pwd: payload?.pwd ?? null,
        code,
        location: payload?.location ?? null,
        username,
        lastAttemptAt: new Date().toISOString(),
      }, scope);
      console.error('[XiaomiAdapter] 登录失败完整响应 payload=', JSON.stringify(payload ?? {}).slice(0, 2000));
      if (payload?.notificationUrl) {
        console.warn('[XiaomiAdapter] 触发米家两步验证，请在浏览器打开:', payload.notificationUrl);
      }
      await this.clearPendingLogin(scope);
      throw new Error(`Xiaomi 登录失败 code=${code} desc=${msg}`);
    }
    if (!payload.userId || !payload.ssecurity || !payload.location) {
      await this.setPendingLogin({
        username,
        cookieHeader: nextCookieHeader,
        formData: data,
        notificationUrl: payload?.notificationUrl,
          context: (() => {
            try {
              return new URL(payload?.notificationUrl || '').searchParams.get('context') || undefined;
            } catch {
              return undefined;
            }
          })(),
          verificationMethod: payload?.notificationUrl ? challengeVerificationMethod : 'browser',
          codeSentAt: null,
        lastAttemptAt: new Date().toISOString(),
        region: regionInput || (scope === 'camera' ? 'de' : REGION_DEFAULT),
      }, scope);
      await this.setAuthStatus({
        state: payload?.notificationUrl ? 'challenge_required' : 'error',
        needsVerification: !!payload?.notificationUrl,
          verificationMethod: payload?.notificationUrl ? challengeVerificationMethod : 'browser',
          message: payload?.notificationUrl
            ? challengeVerificationMethod === 'browser'
              ? '需要米家安全验证，请点击打开验证页完成验证后再回来继续登录'
              : '需要米家邮箱验证码，请先发送验证码，再输入验证码完成登录'
            : '登录已通过初步校验，但仍需完成米家安全验证',
        notificationUrl: payload?.notificationUrl,
        securityStatus: payload?.securityStatus ?? null,
        pwd: payload?.pwd ?? null,
        code: payload?.code ?? null,
        location: payload?.location ?? null,
          codeSentAt: null,
        username,
        lastAttemptAt: new Date().toISOString(),
      }, scope);
      console.error('[XiaomiAdapter] 缺少 userId/ssecurity/location 字段 payload=', JSON.stringify(payload ?? {}).slice(0, 2000));
      if (payload?.notificationUrl) {
        throw new Error('米家需要安全验证，请完成验证后返回本页继续登录');
      }
      throw new Error('Xiaomi 登录响应缺少字段 (userId/ssecurity/location)');
    }
    console.debug('[XiaomiAdapter] 登录成功 userId=', payload.userId, 'region location=', String(payload.location).slice(0, 150));

    const location = payload.location as string;
    const m = location.match(/region=([a-z]{2})/i);
    const scopeDefault = scope === 'camera' ? 'de' : REGION_DEFAULT;
    const region =
      (regionInput?.trim().toLowerCase()) ||
      scopeDefault ||
      (m ? m[1].toLowerCase() : REGION_DEFAULT);

    console.debug('[XiaomiAdapter] step3 callback 获取 serviceToken: url=', String(location).slice(0, 200));
    const cbResp = await axios.get(location, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 10,
      validateStatus: (s: number) => s >= 200 && s < 500,
      headers: {
        Cookie: nextCookieHeader,
        Referer: 'https://account.xiaomi.com/',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI 11 Build/SKQ1.211019.001) APP/com.xiaomi.smarthome APPV/7.0.0',
      },
    });

    const cbSetCookie = (cbResp.headers['set-cookie'] ?? []) as string[];
    let serviceToken = '';
    const combined = [cbSetCookie.join('; ')].join('; ');
    const tokenMatch = /serviceToken=([^;]+)/.exec(combined);
    if (tokenMatch) serviceToken = decodeURIComponent(tokenMatch[1]);
    if (!serviceToken) {
      try {
        const cbCookies: any = (cbResp as any)?.cookies || {};
        if (typeof cbCookies.get === 'function') {
          serviceToken = cbCookies.get('serviceToken') || '';
        }
      } catch { /* ignore */ }
    }
    if (!serviceToken) {
      console.error('[XiaomiAdapter] callback set-cookie=', JSON.stringify(cbSetCookie ?? []).slice(0, 1500), 'status=', cbResp.status);
      throw new Error('Xiaomi 获取 serviceToken 失败，请重新登录（若触发两步验证，可先在手机米家App 账号与安全 关掉安全登录提醒 或改用 Cookie 模式）');
    }
    // #region debug-point D:adapter-callback-token
    (() => {
      const fs = require('node:fs');
      let u = 'http://145.223.100.249:7777/event';
      let s = 'xiaomi-auto-login';
      try {
        const e = fs.readFileSync('.dbg/xiaomi-auto-login.env', 'utf8');
        u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
        s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
      } catch {}
      fetch(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: s,
          runId: 'pre-fix',
          hypothesisId: 'D',
          location: 'xiaomi.adapter.ts:loginHttpWithContext:callback-token',
          msg: '[DEBUG] callback token extracted',
          data: {
            cbStatus: cbResp.status,
            cbSetCookieCount: cbSetCookie.length,
            serviceTokenLength: serviceToken.length,
            region,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion
    console.debug('[XiaomiAdapter] 登录成功：serviceToken len=', serviceToken.length, 'region=', region);
    await this.clearPendingLogin();

    return {
      userId: String(payload.userId),
      serviceToken,
      ssecurity: payload.ssecurity,
      username,
      region,
      loggedAt: new Date().toISOString(),
    };
  }

  private fallbackSession(username: string): XiaomiSession {
    return {
      userId: 'local_' + crypto.randomBytes(4).toString('hex'),
      serviceToken: 'mock_' + crypto.randomBytes(8).toString('hex'),
      ssecurity: 'mock_' + crypto.randomBytes(8).toString('hex'),
      username,
      region: REGION_DEFAULT,
      loggedAt: new Date().toISOString(),
    };
  }

  private async signRequest(session: XiaomiSession, method: 'GET' | 'POST', path: string, params?: Record<string, any>, body?: any) {
    const nonce = generateNonce();
    const signedNonce = sha256Base64(
      Buffer.concat([
        Buffer.from(session.ssecurity, 'base64'),
        Buffer.from(nonce, 'base64'),
      ]),
    );
    const normalizedPath = path.replace(/^\/app/, '').replace(/^\/?/, '/');
    const dataPayload =
      body !== undefined
        ? (typeof body === 'string' ? body : JSON.stringify(body))
        : params && Object.keys(params).length > 0
          ? JSON.stringify(params)
          : undefined;
    const signatureParts = [normalizedPath, signedNonce, nonce];
    if (dataPayload !== undefined) {
      signatureParts.push(`data=${dataPayload}`);
    }
    const signature = hmacSha256Base64(
      Buffer.from(signedNonce, 'base64'),
      signatureParts.join('&'),
    );
    return {
      nonce,
      signedNonce,
      dataPayload,
      signature,
      qs: {
        signature,
        _nonce: nonce,
        data: dataPayload,
      },
    };
  }

  private async requestIo(session: XiaomiSession, method: 'GET' | 'POST', path: string, params?: Record<string, any>, body?: any) {
    const regionLower = (session.region || REGION_DEFAULT).toLowerCase();
    const isIntl = regionLower !== 'cn';
    const intlHostCandidates = isIntl
      ? Array.from(new Set([regionLower, 'de', 'fr', 'at', 'us', 'sg', 'i2', 'ru', 'tw', 'in'].filter((x) => x && x.toLowerCase() !== 'cn')))
      : ['cn'];
    const signByRegion = async (regionForSign: string) => {
      const sessionSnapshot: XiaomiSession = { ...session, region: regionForSign };
      const signed = await this.signRequest(sessionSnapshot, method, path, params, body);
      return signed;
    };
    const localeForRegionFn = (r: string) => {
      const rr = r.toLowerCase();
      if (rr === 'cn') return DEFAULT_LOCALE;
      if (rr === 'at' || rr === 'de') return 'de_DE';
      if (rr === 'fr') return 'fr_FR';
      if (rr === 'ru') return 'ru_RU';
      if (rr === 'sg') return 'en_SG';
      if (rr === 'us') return 'en_US';
      if (rr === 'in') return 'en_IN';
      return 'en_US';
    };
    const timezoneForRegionFn = (r: string) => {
      const rr = r.toLowerCase();
      if (rr === 'cn') return DEFAULT_TIMEZONE;
      if (rr === 'at' || rr === 'de' || rr === 'fr') return 'GMT+01:00';
      if (rr === 'ru') return 'GMT+03:00';
      if (rr === 'sg' || rr === 'in' || rr === 'tw') return 'GMT+08:00';
      if (rr === 'us') return 'GMT-08:00';
      return 'GMT+01:00';
    };
    let lastError: any = null;
    for (const r of intlHostCandidates) {
      try {
        const rr = r.toLowerCase();
        const signed = await signByRegion(rr);
        const regionForApiBase = rr;
        const apiBase = buildApiBaseUrl(regionForApiBase);
        const url = `${apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
        const localeHere = localeForRegionFn(rr);
        const tzHere = timezoneForRegionFn(rr);
        const areaHere = rr === 'i2' ? 'SG' : rr.toUpperCase();
        const isIntlLocal = rr !== 'cn';
        console.info('[XiaomiAdapter.requestIo] probe:', { regionTry: rr, apiBase, path, qsKeys: Object.keys(signed.qs ?? {}).length });
        const resp = await axios({
          url,
          method: 'POST',
          params: signed.qs,
          headers: {
            Cookie: [
              `userId=${session.userId}`,
              `serviceToken=${session.serviceToken}`,
              `yetAnotherServiceToken=${session.serviceToken}`,
              `locale=${localeHere}`,
              `timezone=${encodeURIComponent(tzHere)}`,
              'is_daylight=0',
              'dst_offset=0',
              'channel=MI_APP_STORE',
              isIntlLocal ? `miphone-area=${areaHere}` : null,
            ].filter(Boolean).join('; '),
            'User-Agent': isIntlLocal
              ? 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEABCDEABC APP/xiaomi.smarthome.intl APPV/62830'
              : 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEABCDEABC APP/xiaomi.smarthome APPV/62830',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            ...(isIntlLocal ? { 'MIoT-Region': areaHere } : null),
          },
          timeout: REQUEST_TIMEOUT,
          validateStatus: (s: number) => s >= 200 && s < 500,
        });
        const data = resp.data;
        console.debug('[XiaomiAdapter] requestIo done:', method, path, 'region=', rr, 'status=', resp.status, 'code=', typeof data === 'object' && data ? data.code ?? '<ok>' : '<non-obj>');
        if (resp.status >= 400) {
          const message =
            typeof data === 'object' && data
              ? data?.message || data?.desc || JSON.stringify(data).slice(0, 300)
              : String(data ?? '');
          lastError = new Error(`[XiaomiAdapter] requestIo region=${rr} HTTP ${resp.status}: ${String(message).slice(0, 400)}`);
          continue;
        }
        const listLen =
          (data && typeof data === 'object' && Array.isArray(data.list) && data.list.length) ||
          (data && typeof data === 'object' && Array.isArray(data.device_list) && data.device_list.length) ||
          (data?.result && Array.isArray(data.result.list) && data.result.list.length) ||
          (data?.result && Array.isArray(data.result.device_list) && data.result.device_list.length) ||
          0;
        if (data && typeof data === 'object' && data.code !== undefined && data.code !== 0) {
          if (listLen > 0) {
            return data;
          }
          lastError = new Error(`[XiaomiAdapter] requestIo region=${rr} code=${String(data.code)} msg=${String(data?.message ?? data?.desc ?? '').slice(0, 300)}`);
          continue;
        }
        return data;
      } catch (probeErr: any) {
        lastError = probeErr;
        console.warn('[XiaomiAdapter.requestIo] probeErr:', { region: r, message: probeErr?.message, status: probeErr?.response?.status ?? null });
      }
    }
    if (lastError) throw lastError;
    throw new Error('[XiaomiAdapter] requestIo 所有 EU 归属国探测均未成功');
  }

  private async requestIo_OLD_DISABLED(session: XiaomiSession, method: 'GET' | 'POST', path: string, params?: Record<string, any>, body?: any) {
    const { qs } = await this.signRequest(session, method, path, params, body);
    const url = `${buildApiBaseUrl(session.region)}${path.startsWith('/') ? '' : '/'}${path}`;
    const regionLower = (session.region || REGION_DEFAULT).toLowerCase();
    const isIntl = regionLower !== 'cn';
    const localeForRegion = isIntl
      ? (
        regionLower === 'at' || regionLower === 'de' ? 'de_DE'
        : regionLower === 'fr' ? 'fr_FR'
        : regionLower === 'ru' ? 'ru_RU'
        : regionLower === 'sg' ? 'en_SG'
        : regionLower === 'us' ? 'en_US'
        : regionLower === 'in' ? 'en_IN'
        : 'en_US'
      )
      : DEFAULT_LOCALE;
    const timezoneForRegion = isIntl
      ? (
        regionLower === 'at' || regionLower === 'de' || regionLower === 'fr' ? 'GMT+01:00'
        : regionLower === 'ru' ? 'GMT+03:00'
        : regionLower === 'sg' || regionLower === 'in' ? 'GMT+08:00'
        : regionLower === 'us' ? 'GMT-08:00'
        : 'GMT+01:00'
      )
      : DEFAULT_TIMEZONE;
    try {
      console.debug('[XiaomiAdapter] requestIo start:', method, path, 'qs keys=', Object.keys(qs ?? {}).length, 'region=', regionLower, 'apiBase=', buildApiBaseUrl(session.region));
      const resp = await axios({
        url,
        method: 'POST',
        params: qs,
        headers: {
          Cookie: [
            `userId=${session.userId}`,
            `serviceToken=${session.serviceToken}`,
            `yetAnotherServiceToken=${session.serviceToken}`,
            `locale=${localeForRegion}`,
            `timezone=${encodeURIComponent(timezoneForRegion)}`,
            'is_daylight=0',
            'dst_offset=0',
            'channel=MI_APP_STORE',
            isIntl ? `miphone-area=${regionLower.toUpperCase()}` : null,
          ].filter(Boolean).join('; '),
          'User-Agent': isIntl
            ? 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEABCDEABC APP/xiaomi.smarthome.intl APPV/62830'
            : 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-ABCDEABCDEABC APP/xiaomi.smarthome APPV/62830',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
          ...(isIntl ? { 'MIoT-Region': regionLower.toUpperCase() } : null),
        },
        timeout: REQUEST_TIMEOUT,
        validateStatus: (s: number) => s >= 200 && s < 500,
      });
      const data = resp.data;
      console.debug('[XiaomiAdapter] requestIo done:', method, path, 'status=', resp.status, 'code=', typeof data === 'object' && data ? data.code ?? '<ok>' : '<non-obj>');
      if (resp.status >= 400) {
        const message =
          typeof data === 'object' && data
            ? data?.message || data?.desc || JSON.stringify(data).slice(0, 300)
            : String(data ?? '');
        throw new Error(`Xiaomi io HTTP_${resp.status}:${message}`);
      }
      if (resp.status === 401 || resp.status === 403) {
        const message =
          typeof data === 'object' && data
            ? data?.message || data?.desc || JSON.stringify(data).slice(0, 300)
            : String(data ?? '');
        throw new Error(`INVALID_SESSION_HTTP_${resp.status}:${message}`);
      }
      if (data && typeof data === 'object' && (data.code === 0 || data.code === 'ok' || data.status === 'ok')) {
        return data?.result ?? data?.data ?? true;
      }
      if (data && typeof data === 'object' && (data.code === -6 || /invalid|expired/i.test(data?.message || ''))) {
        throw new Error('INVALID_SESSION');
      }
      if (data && typeof data === 'object' && data.code !== undefined) {
        console.error('[XiaomiAdapter] requestIo 业务码非 0 payload 片段=', JSON.stringify(data ?? {}).slice(0, 800));
        throw new Error(`Xiaomi io code=${data.code} message=${data?.message || data?.desc}`);
      }
      return data;
    } catch (err: any) {
      if (err?.message?.includes('INVALID_SESSION')) throw err;
      console.error('[XiaomiAdapter] requestIo network err=', method, path, err?.message || err);
      throw new Error(`Xiaomi io 请求失败：${err?.message || err}`);
    }
  }

  private async verifySession(session: XiaomiSession): Promise<void> {
    const ioPath = DEVICE_LIST_URL.replace(/^https:\/\/api\.io\.mi\.com/, '');
    try {
      await this.requestIo(session, 'POST', ioPath, undefined, { getVirtualModel: false, getHuamiDevices: 0 });
      // #region debug-point D:adapter-verify-session-success
      (() => {
        const fs = require('node:fs');
        let u = 'http://127.0.0.1:7777/event';
        let s = 'xiaomi-login-still-fails';
        try {
          const e = fs.readFileSync('.dbg/xiaomi-login-still-fails.env', 'utf8');
          u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
          s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
        } catch {}
        fetch(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: s,
            runId: 'pre-fix',
            hypothesisId: 'D',
            location: 'xiaomi.adapter.ts:verifySession:success',
            msg: '[DEBUG] session verification succeeded',
            data: { userId: session.userId, region: session.region ?? null },
            ts: Date.now(),
          }),
        }).catch(() => {});
      })();
      // #endregion
    } catch (err: any) {
      // #region debug-point D:adapter-verify-session-failed
      (() => {
        const fs = require('node:fs');
        let u = 'http://127.0.0.1:7777/event';
        let s = 'xiaomi-login-still-fails';
        try {
          const e = fs.readFileSync('.dbg/xiaomi-login-still-fails.env', 'utf8');
          u = e.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || u;
          s = e.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || s;
        } catch {}
        fetch(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: s,
            runId: 'pre-fix',
            hypothesisId: 'D',
            location: 'xiaomi.adapter.ts:verifySession:failed',
            msg: '[DEBUG] session verification failed',
            data: { userId: session.userId, message: err?.message || String(err) },
            ts: Date.now(),
          }),
        }).catch(() => {});
      })();
      // #endregion
      const rawMessage = String(err?.message || err || '');
      const region = String(session.region || REGION_DEFAULT).toUpperCase();
      if (/requestIo region=.*HTTP 401/i.test(rawMessage) || /auth error/i.test(rawMessage)) {
        throw new Error(`米家会话已失效或地区不匹配（当前地区 ${region}），请重新登录对应地区账号`);
      }
      throw new Error(`米家会话串不可用：${rawMessage}`);
    }
  }

  public async fetchDevices(): Promise<XiaomiDeviceInfo[]> {
    const session = await this.getSession();
    const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, name: true } });
    const existingDevices = await prisma.device.findMany({
      select: { did: true, roomId: true },
    });
    const listReal: XiaomiDeviceInfo[] = [];

    const isRealSession = !!(session && /^mock_/.test(session.serviceToken) === false);
    console.info('[XiaomiAdapter] fetchDevices 开始: isRealSession=', isRealSession);
    if (isRealSession) {
      try {
        const ioPath = DEVICE_LIST_URL.replace(/^https:\/\/api\.io\.mi\.com/, '');
        const deviceResponse = await this.requestIo(session, 'POST', ioPath, undefined, {
          getVirtualModel: false,
          getHuamiDevices: 0,
        }) as unknown;
        const devicePayload = deviceResponse as {
          list?: RawDevice[];
          result?: { list?: RawDevice[] };
        } | RawDevice[] | null;
        const list = Array.isArray(devicePayload)
          ? devicePayload
          : Array.isArray(devicePayload?.list)
            ? devicePayload.list
            : Array.isArray(devicePayload?.result?.list)
              ? devicePayload.result.list
              : null;
        console.info('[XiaomiAdapter] fetchDevices requestIo 返回长度=', Array.isArray(list) ? list.length : '非数组 null');
        if (Array.isArray(list) && list.length > 0) {
          console.info('[XiaomiAdapter] 前3设备 did/name/model=', list.slice(0, 3).map(r => ({ did: r.did, name: r.name, model: r.model, status: r.status, isOnline: r.isOnline })));
        }
        if (Array.isArray(list)) {
          const props = await this.batchGetProps(session, list);
          for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            const p = props[raw.did] ?? {};
            listReal.push(buildDeviceInfoItem(
              raw,
              i,
              rooms,
              existingDevices,
              this.lastRoomMap,
              p,
              session?.region,
            ));
          }
          assignFallbackRoomIds(listReal, rooms, existingDevices, this.lastRoomMap);
        } else if (devicePayload !== null && devicePayload !== undefined) {
          console.warn('[XiaomiAdapter] fetchDevices 响应非数组，内容片段=', JSON.stringify(devicePayload).slice(0, 600));
        }
      } catch (err: any) {
        console.error('[XiaomiAdapter] fetchDevices io 异常：', err?.message, err?.stack ?? '');
      }
    } else {
      console.warn('[XiaomiAdapter] fetchDevices 当前为兼容会话（mock serviceToken），不生成任何占位设备；请前往系统设置点 重新登录 或确保 docker-compose.yml XIAOMI_USERNAME/PASSWORD 真实可登');
    }

    for (const d of listReal) {
      if (!d.roomId) continue;
      this.lastRoomMap[d.did] = d.roomId;
    }
    console.info('[XiaomiAdapter] fetchDevices 完成：返回真实设备 count=', listReal.length);
    return listReal;
  }

  private async batchGetProps(session: XiaomiSession, list: RawDevice[]): Promise<Record<string, { power?: boolean; powerW?: number; currentA?: number; voltageV?: number; totalKwh?: number }>> {
    if (list.length === 0) return {};
    const result: Record<string, DevicePropSnapshot> = {};
    const onlineDevices = list.filter((d) => d.isOnline === true);
    const payload = onlineDevices.flatMap((device) => buildMiotPropQueriesForDevice(device));

    if (payload.length === 0) return {};

    const path = '/app/miotspec/prop/get';
    try {
      const resp = await this.requestIo(session, 'POST', path, undefined, { params: payload }) as any[] | { list?: any[] } | null;
      const items = Array.isArray(resp)
        ? resp
        : Array.isArray(resp?.list)
          ? resp.list
          : Array.isArray((resp as any)?.result)
            ? (resp as any).result
            : Array.isArray((resp as any)?.result?.list)
              ? (resp as any).result.list
              : [];
      if (Array.isArray(items)) {
        for (const device of onlineDevices) {
          result[device.did] = parseDevicePropResponse(device, items);
        }
      }

      for (const did of Object.keys(result)) {
        const snapshot = result[did];
        if (snapshot.power == null && typeof snapshot.powerW === 'number' && Number.isFinite(snapshot.powerW)) {
          snapshot.power = snapshot.powerW > 0;
        }
      }
    } catch (e: any) {
      console.warn('[XiaomiAdapter] batchGetProps 跳过：', e?.message);
    }
    return result;
  }

  private buildPropQueries(device: RawDevice): MiotPropQueryItem[] {
    const queries: MiotPropQueryItem[] = [{ did: device.did, siid: 2, piid: 1 }];
    const model = device.model ?? '';

    if (model.includes('lxzn.switch.cbcsmj')) {
      return queries.concat([
        { did: device.did, siid: 3, piid: 1 },
        { did: device.did, siid: 3, piid: 2 },
        { did: device.did, siid: 3, piid: 3 },
        { did: device.did, siid: 3, piid: 6 },
      ]);
    }

    return queries.concat([
      { did: device.did, siid: 2, piid: 2 },
      { did: device.did, siid: 2, piid: 3 },
      { did: device.did, siid: 2, piid: 4 },
      { did: device.did, siid: 2, piid: 5 },
      { did: device.did, siid: 2, piid: 6 },
      { did: device.did, siid: 3, piid: 1 },
      { did: device.did, siid: 3, piid: 2 },
      { did: device.did, siid: 3, piid: 3 },
      { did: device.did, siid: 3, piid: 6 },
    ]);
  }

  private async getSingleDeviceSnapshot(
    session: XiaomiSession,
    deviceDid: string,
  ): Promise<DevicePropSnapshot | null> {
    const device = await prisma.device.findUnique({
      where: { did: deviceDid },
      select: { did: true, model: true, status: true },
    });
    if (!device) {
      return null;
    }

    const snapshots = await this.batchGetProps(session, [
      {
        did: device.did,
        model: device.model,
        isOnline: true,
      },
    ]);

    return snapshots[deviceDid] ?? null;
  }

  private async confirmDevicePowerState(
    session: XiaomiSession,
    deviceDid: string,
    expectedPower: boolean,
    options?: PowerConfirmationOptions,
  ): Promise<DevicePropSnapshot> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 4);
    const initialDelayMs = Math.max(0, options?.initialDelayMs ?? 0);
    const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 2000);

    if (initialDelayMs > 0) {
      await sleep(initialDelayMs);
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const snapshot = await this.getSingleDeviceSnapshot(session, deviceDid);
      if (snapshot && snapshot.power === expectedPower) {
        return snapshot;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(retryDelayMs);
      }
    }

    throw new Error(
      `米家设备状态确认失败，期望电源=${expectedPower ? '开启' : '关闭'}，did=${deviceDid}`,
    );
  }

  private assignPropValue(
    snapshot: DevicePropSnapshot,
    model: string,
    siid: number,
    piid: number,
    rawValue: unknown,
  ) {
    const numericValue = this.toNumericValue(rawValue);

    if (siid === 2 && piid === 1) {
      if (typeof rawValue === 'boolean') {
        snapshot.power = rawValue;
        return;
      }
      if (numericValue != null) {
        snapshot.power = numericValue === 1;
        return;
      }
    }

    if (siid === 3 && piid === 6 && numericValue != null) {
      snapshot.powerW = normalizeDeviceTelemetryValue(model, 'powerW', numericValue);
      return;
    }

    if (siid === 3 && piid === 2 && numericValue != null) {
      snapshot.currentA = normalizeDeviceTelemetryValue(model, 'currentA', numericValue);
      return;
    }

    if (siid === 3 && piid === 3 && numericValue != null) {
      snapshot.voltageV = normalizeDeviceTelemetryValue(model, 'voltageV', numericValue);
      return;
    }

    if (siid === 3 && piid === 1 && numericValue != null) {
      snapshot.totalKwh = this.normalizeTotalKwh(model, numericValue);
      return;
    }

    if (siid === 2 && piid === 2 && numericValue != null) {
      snapshot.powerW = normalizeDeviceTelemetryValue(model, 'powerW', numericValue);
      return;
    }

    if (siid === 2 && piid === 3 && numericValue != null) {
      snapshot.currentA = normalizeDeviceTelemetryValue(model, 'currentA', numericValue);
      return;
    }

    if (siid === 2 && piid === 4 && numericValue != null) {
      snapshot.voltageV = normalizeDeviceTelemetryValue(model, 'voltageV', numericValue);
      return;
    }

    if ((siid === 2 && piid === 5) || (siid === 2 && piid === 6)) {
      if (numericValue != null) {
        snapshot.totalKwh = this.normalizeTotalKwh(model, numericValue);
      }
    }
  }

  private normalizeTotalKwh(model: string, numericValue: number): number {
    return normalizeDeviceTelemetryValue(model, 'totalKwh', numericValue) ?? numericValue;
  }

  private parseHistoryNumericValue(rawValue: unknown): number | null {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = Number(parsed[0]);
          return Number.isFinite(first) ? first : null;
        }
      } catch {
        const direct = Number(rawValue);
        return Number.isFinite(direct) ? direct : null;
      }
    }
    if (Array.isArray(rawValue) && rawValue.length > 0) {
      const first = Number(rawValue[0]);
      return Number.isFinite(first) ? first : null;
    }
    return null;
  }

  private getDayKeyFromUnix(tsSec: number, timeZone: string): string {
    return getDayKey(new Date(tsSec * 1000), timeZone);
  }

  private dayKeyToDate(dayKey: string, timeZone: string): Date {
    return dayKeyToDate(dayKey, timeZone);
  }

  private getTodayDayKey(timeZone: string): string {
    return getDayKey(new Date(), timeZone);
  }

  private parseStoreDayHistory(
    rawValue: unknown,
    businessTimeZone: string,
  ): Array<{ dayKey: string; usageKwh: number }> {
    if (typeof rawValue !== 'string') return [];

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed) || parsed.length < 2) return [];

      return parsed
        .slice(1)
        .map((row) => {
          if (typeof row !== 'string') return null;
          const [timeRaw, valueRaw] = row.split(',');
          const time = Number(timeRaw);
          const usage = Number(valueRaw);
          if (!Number.isFinite(time) || !Number.isFinite(usage)) return null;
          return {
            dayKey: this.getDayKeyFromUnix(time, businessTimeZone),
            usageKwh: Number((usage > 50 ? usage / 1000 : usage).toFixed(3)),
          };
        })
        .filter(Boolean) as Array<{ dayKey: string; usageKwh: number }>;
    } catch {
      return [];
    }
  }

  private buildDailyUsageFromCumulativeSamples(
    model: string,
    samples: Array<{ time: number; value: unknown }>,
    businessTimeZone: string,
  ): Array<{ dayKey: string; usageKwh: number }> {
    const normalized = samples
      .map((sample) => {
        const numeric = this.parseHistoryNumericValue(sample.value);
        if (numeric == null) return null;
        return {
          time: Number(sample.time),
          cumulativeKwh: this.normalizeTotalKwh(model, numeric),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.time - b!.time) as Array<{ time: number; cumulativeKwh: number }>;

    if (normalized.length < 2) return [];

    const byDay = new Map<string, { first: number; last: number }>();
    for (const sample of normalized) {
      const dayKey = this.getDayKeyFromUnix(sample.time, businessTimeZone);
      const day = byDay.get(dayKey);
      if (!day) {
        byDay.set(dayKey, { first: sample.cumulativeKwh, last: sample.cumulativeKwh });
      } else {
        day.last = sample.cumulativeKwh;
      }
    }

    const sortedDays = Array.from(byDay.keys()).sort();
    const result: Array<{ dayKey: string; usageKwh: number }> = [];
    let previousLast: number | null = null;

    for (const dayKey of sortedDays) {
      const day = byDay.get(dayKey)!;
      let usage = previousLast != null ? day.last - previousLast : day.last - day.first;
      if (!Number.isFinite(usage) || usage < 0) {
        usage = day.last - day.first;
      }
      result.push({
        dayKey,
        usageKwh: Number(Math.max(0, usage).toFixed(3)),
      });
      previousLast = day.last;
    }

    return result;
  }

  private normalizeCumulativeSamples(
    model: string,
    samples: Array<{ time: number; value: unknown }>,
    currentTotalKwh?: number | null,
  ): Array<{ time: number; cumulativeKwh: number }> {
    const normalized = samples
      .map((sample) => {
        const numeric = this.parseHistoryNumericValue(sample.value);
        if (numeric == null) return null;
        return {
          time: Number(sample.time),
          cumulativeKwh: this.normalizeTotalKwh(model, numeric),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a!.time - b!.time) as Array<{ time: number; cumulativeKwh: number }>;

    if (currentTotalKwh != null && Number.isFinite(currentTotalKwh)) {
      const nowSec = Math.floor(Date.now() / 1000);
      const last = normalized.at(-1);
      if (!last || nowSec > last.time) {
        normalized.push({
          time: nowSec,
          cumulativeKwh: Number(currentTotalKwh.toFixed(3)),
        });
      } else if (nowSec === last.time) {
        last.cumulativeKwh = Number(currentTotalKwh.toFixed(3));
      }
    }

    return normalized;
  }

  private estimateCumulativeAtTime(
    normalizedSamples: Array<{ time: number; cumulativeKwh: number }>,
    targetSec: number,
  ): number | null {
    if (normalizedSamples.length === 0) return null;

    let previous: { time: number; cumulativeKwh: number } | null = null;
    let next: { time: number; cumulativeKwh: number } | null = null;

    for (const sample of normalizedSamples) {
      if (sample.time <= targetSec) {
        previous = sample;
      }
      if (sample.time >= targetSec) {
        next = sample;
        break;
      }
    }

    if (previous && next) {
      if (previous.time === next.time) {
        return previous.cumulativeKwh;
      }
      const ratio = (targetSec - previous.time) / (next.time - previous.time);
      return Number(
        (previous.cumulativeKwh + (next.cumulativeKwh - previous.cumulativeKwh) * ratio).toFixed(3),
      );
    }

    if (previous) return previous.cumulativeKwh;
    if (next) return next.cumulativeKwh;
    return null;
  }

  private computeTodayUsageFromCounterSamples(
    model: string,
    samples: Array<{ time: number; value: unknown }>,
    businessTimeZone: string,
    currentTotalKwh?: number | null,
  ): number | null {
    const normalized = this.normalizeCumulativeSamples(model, samples, currentTotalKwh);
    if (normalized.length === 0) return null;

    const todayStartSec = Math.floor(
      getBusinessDayStartUtc(new Date(), businessTimeZone).getTime() / 1000,
    );
    const baselineKwh = this.estimateCumulativeAtTime(normalized, todayStartSec);
    const currentKwh =
      currentTotalKwh != null && Number.isFinite(currentTotalKwh)
        ? Number(currentTotalKwh.toFixed(3))
        : normalized.at(-1)?.cumulativeKwh ?? null;

    if (baselineKwh == null || currentKwh == null) {
      return null;
    }

    return Number(Math.max(0, currentKwh - baselineKwh).toFixed(3));
  }

  private async fetchHistorySamples(
    session: XiaomiSession,
    did: string,
    body: Record<string, any>,
  ): Promise<any[]> {
    const path = '/app/user/get_user_device_data';
    const resp = await this.requestIo(session, 'POST', path, undefined, body) as any[] | { list?: any[] } | null;
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp?.list)) return resp.list;
    return [];
  }

  private async fetchCumulativeCounterSamples(
    session: XiaomiSession,
    device: { did: string; model: string; totalKwh?: number | null },
    timeStartSec: number,
    timeEndSec: number,
    limit: number,
  ): Promise<Array<{ time: number; cumulativeKwh: number }>> {
    const cumulativeRows = await this.fetchHistorySamples(session, device.did, {
      did: device.did,
      key: '3.1',
      type: 'prop',
      time_start: timeStartSec,
      time_end: timeEndSec,
      limit,
    }).catch(() => []);

    return this.normalizeCumulativeSamples(
      device.model,
      cumulativeRows.map((row) => ({
        time: Number(row?.time ?? 0),
        value: row?.value,
      })),
      device.totalKwh ?? null,
    );
  }

  private async fetchDailyUsageHistoryForDevice(
    session: XiaomiSession,
    device: { did: string; model: string; roomId: string | null; totalKwh?: number | null },
    days: number,
    businessTimeZone: string,
  ): Promise<{ dailyUsage: Array<{ dayKey: string; usageKwh: number }>; todayUsageKwh: number | null }> {
    const todayStartUtc = getBusinessDayStartUtc(new Date(), businessTimeZone);
    const timeStart = Math.floor((todayStartUtc.getTime() - days * 24 * 60 * 60 * 1000) / 1000);
    const timeEnd = Math.floor(Date.now() / 1000);
    const limit = Math.min(Math.max(days * 160, 1500), 5000);

    const normalizedCounterSamples = await this.fetchCumulativeCounterSamples(
      session,
      device,
      timeStart,
      timeEnd,
      limit,
    );

    const todayUsageKwh = this.computeTodayUsageFromCounterSamples(
      device.model,
      normalizedCounterSamples.map((sample) => ({
        time: sample.time,
        value: sample.cumulativeKwh,
      })),
      businessTimeZone,
    );

    const cumulativeDaily = this.buildDailyUsageFromCumulativeSamples(
      device.model,
      normalizedCounterSamples.map((sample) => ({
        time: sample.time,
        value: sample.cumulativeKwh,
      })),
      businessTimeZone,
    );
    const nonZeroCumulativeDaily = cumulativeDaily.filter((item) => item.usageKwh > 0);
    if (nonZeroCumulativeDaily.length > 0) {
      return {
        dailyUsage: nonZeroCumulativeDaily,
        todayUsageKwh,
      };
    }

    const storeRows = await this.fetchHistorySamples(session, device.did, {
      did: device.did,
      key: 'powerCost',
      type: 'store',
      time_start: timeStart,
      time_end: timeEnd,
      limit: days + 5,
      group: 'day',
    }).catch(() => []);

    return {
      dailyUsage: storeRows
        .flatMap((row) => this.parseStoreDayHistory(row?.value, businessTimeZone))
        .filter((item) => item.usageKwh > 0),
      todayUsageKwh,
    };
  }

  private async syncDailyHistory(days: number = 35): Promise<void> {
    const session = await this.getSession();
    if (!session || /^mock_/.test(session.serviceToken)) return;
    const businessTimeZone = await getBusinessTimeZoneSetting();
    const pricePerKwh = await getPricePerKwhSetting();

    const devices = await prisma.device.findMany({
      where: {
        roomId: { not: null },
      },
      select: {
        did: true,
        model: true,
        roomId: true,
        totalKwh: true,
      },
    });

    if (devices.length === 0) return;

    const roomDayUsage = new Map<string, number>();
    const roomTodayUsage = new Map<string, number>();
    const todayDayKey = this.getTodayDayKey(businessTimeZone);
    for (const device of devices) {
      const { dailyUsage, todayUsageKwh } = await this.fetchDailyUsageHistoryForDevice(
        session,
        device,
        days,
        businessTimeZone,
      ).catch(() => ({
        dailyUsage: [],
        todayUsageKwh: null,
      }));
      for (const item of dailyUsage ?? []) {
        if (!device.roomId || item.dayKey === todayDayKey || item.usageKwh <= 0) continue;
        const mapKey = `${device.roomId}:${item.dayKey}`;
        roomDayUsage.set(mapKey, Number(((roomDayUsage.get(mapKey) ?? 0) + item.usageKwh).toFixed(3)));
      }
      if (device.roomId && todayUsageKwh != null && todayUsageKwh > 0) {
        roomTodayUsage.set(
          device.roomId,
          Number(((roomTodayUsage.get(device.roomId) ?? 0) + todayUsageKwh).toFixed(3)),
        );
      }
    }

    for (const [mapKey, usageKwh] of roomDayUsage.entries()) {
      const [roomId, dayKey] = mapKey.split(':');
      const date = this.dayKeyToDate(dayKey, businessTimeZone);

      await prisma.dailyEnergy.upsert({
        where: { roomId_date: { roomId, date } },
        update: {
          usageKwh,
          cost: Number((usageKwh * pricePerKwh).toFixed(2)),
        },
        create: {
          roomId,
          date,
          usageKwh,
          cost: Number((usageKwh * pricePerKwh).toFixed(2)),
        },
      });
    }

    const todayDate = this.dayKeyToDate(todayDayKey, businessTimeZone);
    for (const [roomId, usageKwh] of roomTodayUsage.entries()) {
      await prisma.dailyEnergy.upsert({
        where: { roomId_date: { roomId, date: todayDate } },
        update: {
          usageKwh,
          cost: Number((usageKwh * pricePerKwh).toFixed(2)),
        },
        create: {
          roomId,
          date: todayDate,
          usageKwh,
          cost: Number((usageKwh * pricePerKwh).toFixed(2)),
        },
      });
    }

    this.lastDailyHistorySyncAt = Date.now();
  }

  public async ensureDailyHistoryFresh(days: number = 35, maxAgeMs: number = 60 * 1000): Promise<void> {
    if (this.lastDailyHistorySyncAt && Date.now() - this.lastDailyHistorySyncAt <= maxAgeMs) {
      return;
    }

    if (this.dailyHistorySyncPromise) {
      await this.dailyHistorySyncPromise;
      return;
    }

    this.dailyHistorySyncPromise = this.syncDailyHistory(days)
      .catch((error) => {
        console.warn('[XiaomiAdapter] ensureDailyHistoryFresh 刷新失败：', error?.message || error);
      })
      .finally(() => {
        this.dailyHistorySyncPromise = null;
      });

    await this.dailyHistorySyncPromise;
  }

  public async getRoomTodayHourlyUsage(
    roomId: string,
    businessTimeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  ): Promise<Array<{ hour: number; usage: number }>> {
    const session = await this.getSession();
    if (!session || /^mock_/.test(session.serviceToken)) {
      return Array.from({ length: 24 }, (_, hour) => ({ hour, usage: 0 }));
    }

    const devices = await prisma.device.findMany({
      where: { roomId },
      select: {
        did: true,
        model: true,
        totalKwh: true,
      },
    });

    if (devices.length === 0) {
      return Array.from({ length: 24 }, (_, hour) => ({ hour, usage: 0 }));
    }

    const dayStartSec = Math.floor(
      getBusinessDayStartUtc(new Date(), businessTimeZone).getTime() / 1000,
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const limit = 1500;
    const usageByHour = Array.from({ length: 24 }, () => 0);

    for (const device of devices) {
      const samples = await this.fetchCumulativeCounterSamples(
        session,
        device,
        dayStartSec - 3600,
        nowSec,
        limit,
      ).catch(() => []);

      if (samples.length === 0) {
        continue;
      }

      for (let hour = 0; hour < 24; hour += 1) {
        const startSec = dayStartSec + hour * 3600;
        const endSec = Math.min(dayStartSec + (hour + 1) * 3600, nowSec);
        if (endSec <= startSec) {
          continue;
        }

        const startKwh = this.estimateCumulativeAtTime(samples, startSec);
        const endKwh = this.estimateCumulativeAtTime(samples, endSec);
        if (startKwh == null || endKwh == null) {
          continue;
        }

        usageByHour[hour] += Math.max(0, endKwh - startKwh);
      }
    }

    return usageByHour.map((usage, hour) => ({
      hour,
      usage: Number(usage.toFixed(3)),
    }));
  }

  private toNumericValue(rawValue: unknown): number | null {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private assignFallbackRoomIds(
    devices: XiaomiDeviceInfo[],
    rooms: { id: string; roomNumber: string; name: string }[],
    existingDevices: { did: string; roomId: string | null }[],
  ): void {
    const existingRoomMap = new Map(
      existingDevices
        .filter((device) => !!device.roomId)
        .map((device) => [device.did, device.roomId as string]),
    );

    const occupiedRoomIds = new Set<string>();

    for (const device of devices) {
      if (device.roomId) {
        occupiedRoomIds.add(device.roomId);
      }
    }

    for (const device of devices) {
      if (device.roomId) continue;
      const existingRoomId = existingRoomMap.get(device.did);
      if (existingRoomId && rooms.some((room) => room.id === existingRoomId) && !occupiedRoomIds.has(existingRoomId)) {
        device.roomId = existingRoomId;
        occupiedRoomIds.add(existingRoomId);
        this.lastRoomMap[device.did] = existingRoomId;
      }
    }

    const availableRooms = rooms.filter((room) => !occupiedRoomIds.has(room.id));

    for (const device of devices) {
      if (device.roomId) continue;
      const nextRoom = availableRooms.shift();
      if (!nextRoom) break;
      device.roomId = nextRoom.id;
      this.lastRoomMap[device.did] = nextRoom.id;
      occupiedRoomIds.add(nextRoom.id);
    }
  }

  private resolveRoomId(rooms: { id: string; roomNumber: string; name: string }[], raw: RawDevice): string | null {
    const name = `${raw.name ?? ''} ${raw.did ?? ''}`.toLowerCase();
    for (const r of rooms) {
      if (name.includes(String(r.roomNumber))) return r.id;
      if (r.name && name.includes(r.name.toLowerCase())) return r.id;
    }
    const fallback = this.lastRoomMap[raw.did];
    if (fallback) return fallback;

    const numMatch = /(10[1-9]|11[0-4])/.exec(name);
    if (numMatch) {
      const r = rooms.find((x) => x.roomNumber === numMatch[1]);
      if (r) { this.lastRoomMap[raw.did] = r.id; return r.id; }
    }
    const chineseMap: Record<string, string[]> = {
      keting: ['客厅', 'living'],
      woshi: ['主卧', '卧室', 'master'],
      chwoshi: ['次卧', 'bedroom2'],
      kt: ['客厅'],
      ws: ['卫生间', 'wash'],
      cf: ['厨房', 'kitchen'],
    };
    for (const [_key, tokens] of Object.entries(chineseMap)) {
      for (const t of tokens) {
        if (name.includes(t)) {
          const r = rooms.find((x) => x.roomNumber === '101');
          if (r) { this.lastRoomMap[raw.did] = r.id; return r.id; }
        }
      }
    }
    return null;
  }

  public async syncDevicesToDb(
    operatorUserId: string | null,
    actorContext?: OperationActorContext,
  ): Promise<void> {
    await prisma.device.deleteMany({
      where: { did: { startsWith: 'miot_device_' } },
    });

    const mergedDevices: XiaomiDeviceInfo[] = [];
    const mainSession = await this.getSession('main');
    if (mainSession && !/^mock_/.test(mainSession.serviceToken)) {
      mergedDevices.push(...(await this.fetchDevices()));
    }

    const cameraSession = await this.getSession('camera');
    if (cameraSession && !/^mock_/.test(cameraSession.serviceToken)) {
      mergedDevices.push(...(await this.fetchCameraDevices()));
    }

    if (mergedDevices.length === 0) {
      throw new Error('米家尚未完成真实登录，当前没有可用的真实会话。请先在系统设置里重新登录米家账号。');
    }

    await syncXiaomiDevicesToDb(mergedDevices, operatorUserId, actorContext);
  }

  private async getDeviceAuditDetails(deviceDid: string): Promise<{
    roomId: string | null;
    roomNumber: string | null;
    roomName: string | null;
    displayName: string | null;
    deviceName: string | null;
  }> {
    const device = await prisma.device.findUnique({
      where: { did: deviceDid },
      include: {
        room: {
          select: {
            id: true,
            roomNumber: true,
            name: true,
          },
        },
      },
    });

    return {
      roomId: device?.room?.id ?? null,
      roomNumber: device?.room?.roomNumber ?? null,
      roomName: device?.room?.name ?? null,
      displayName:
        device?.room?.roomNumber
          ? formatRoomDisplayName(device.room.roomNumber, device.room.name)
          : device?.name?.trim() || null,
      deviceName: device?.name?.trim() || null,
    };
  }

  public async turnOn(
    deviceDid: string,
    operatorUserId: string | null | undefined,
    actorContext?: OperationActorContext,
    confirmationOptions?: PowerConfirmationOptions,
  ): Promise<boolean> {
    const auditTarget = await this.getDeviceAuditDetails(deviceDid);

    try {
      const session = await this.getSession();
      if (!session) {
        throw new AppError(400, 'XIAOMI_NOT_LOGGED_IN', '米家未登录，无法开启设备');
      }
      if (/^mock_/.test(session.serviceToken)) {
        throw new AppError(400, 'XIAOMI_SESSION_INVALID', '当前米家会话不是真实会话，无法开启设备');
      }

      const result = await this.requestIo(session, 'POST', '/app/miotspec/prop/set', {}, {
        params: [{ did: deviceDid, siid: 2, piid: 1, value: true }],
      });
      if (Array.isArray(result)) {
        const failed = result.find((item) => item?.code !== undefined && Number(item.code) !== 0);
        if (failed) {
          throw new Error(`米家返回开启失败 code=${failed.code}`);
        }
      }
      const confirmed = await this.confirmDevicePowerState(
        session,
        deviceDid,
        true,
        confirmationOptions,
      );
      const previous = await prisma.device.findUnique({
        where: { did: deviceDid },
        select: { powerW: true, currentA: true, voltageV: true, totalKwh: true, power: true },
      }) as DeviceRuntimePrevious | null;
      const safe = sanitizeRuntimeForUpsert(
        {
          powerW: confirmed.powerW,
          currentA: confirmed.currentA,
          voltageV: confirmed.voltageV,
          totalKwh: confirmed.totalKwh,
          online: true,
        },
        previous,
      );
      await prisma.device.update({
        where: { did: deviceDid },
        data: {
          status: DeviceStatus.online,
          power: true,
          powerW: safe.powerW,
          currentA: safe.currentA,
          voltageV: safe.voltageV,
          totalKwh: safe.totalKwh,
          lastSyncAt: new Date(),
        },
      });
      await writeOperation(
        operatorUserId ?? null,
        OperationType.control_device,
        auditTarget.roomId,
        {
          action: 'turn_on',
          actionLabel: actorContext?.source === 'system_auto' ? '自动开电' : '手动开电',
          source: actorContext?.source,
          sourceLabel: actorContext?.sourceLabel,
          roomNumber: auditTarget.roomNumber,
          roomName: auditTarget.roomName,
          displayName: auditTarget.displayName,
          deviceName: auditTarget.deviceName,
          did: deviceDid,
          powerAction: 'on',
        },
        true,
      );
      return true;
    } catch (e: any) {
      await writeOperation(
        operatorUserId ?? null,
        OperationType.control_device,
        auditTarget.roomId,
        {
          action: 'turn_on',
          actionLabel: actorContext?.source === 'system_auto' ? '自动开电失败' : '手动开电失败',
          source: actorContext?.source,
          sourceLabel: actorContext?.sourceLabel,
          roomNumber: auditTarget.roomNumber,
          roomName: auditTarget.roomName,
          displayName: auditTarget.displayName,
          deviceName: auditTarget.deviceName,
          did: deviceDid,
          powerAction: 'on',
          error: e?.message || String(e),
        },
        false,
      );
      throw new AppError(
        e instanceof AppError ? e.statusCode : 502,
        e instanceof AppError ? e.code : 'XIAOMI_DEVICE_CONTROL_FAILED',
        e?.message || '米家开启设备失败',
      );
    }
  }

  public async turnOff(
    deviceDid: string,
    operatorUserId: string | null | undefined,
    actorContext?: OperationActorContext,
  ): Promise<boolean> {
    const auditTarget = await this.getDeviceAuditDetails(deviceDid);

    try {
      const session = await this.getSession();
      if (!session) {
        throw new AppError(400, 'XIAOMI_NOT_LOGGED_IN', '米家未登录，无法关闭设备');
      }
      if (/^mock_/.test(session.serviceToken)) {
        throw new AppError(400, 'XIAOMI_SESSION_INVALID', '当前米家会话不是真实会话，无法关闭设备');
      }

      const result = await this.requestIo(session, 'POST', '/app/miotspec/prop/set', {}, {
        params: [{ did: deviceDid, siid: 2, piid: 1, value: false }],
      });
      if (Array.isArray(result)) {
        const failed = result.find((item) => item?.code !== undefined && Number(item.code) !== 0);
        if (failed) {
          throw new Error(`米家返回断电失败 code=${failed.code}`);
        }
      }
      const confirmed = await this.confirmDevicePowerState(session, deviceDid, false);
      const previous = await prisma.device.findUnique({
        where: { did: deviceDid },
        select: { powerW: true, currentA: true, voltageV: true, totalKwh: true, power: true },
      }) as DeviceRuntimePrevious | null;
      const safe = sanitizeRuntimeForUpsert(
        {
          powerW: confirmed.powerW ?? 0,
          currentA: confirmed.currentA ?? 0,
          voltageV: confirmed.voltageV,
          totalKwh: confirmed.totalKwh,
          online: true,
        },
        previous,
      );
      await prisma.device.update({
        where: { did: deviceDid },
        data: {
          status: DeviceStatus.online,
          power: false,
          powerW: safe.powerW ?? 0,
          currentA: safe.currentA ?? 0,
          voltageV: safe.voltageV,
          totalKwh: safe.totalKwh,
          lastSyncAt: new Date(),
        },
      });
      await writeOperation(
        operatorUserId ?? null,
        OperationType.control_device,
        auditTarget.roomId,
        {
          action: 'turn_off',
          actionLabel: actorContext?.source === 'system_auto' ? '自动断电' : '手动断电',
          source: actorContext?.source,
          sourceLabel: actorContext?.sourceLabel,
          roomNumber: auditTarget.roomNumber,
          roomName: auditTarget.roomName,
          displayName: auditTarget.displayName,
          deviceName: auditTarget.deviceName,
          did: deviceDid,
          powerAction: 'off',
        },
        true,
      );
      return true;
    } catch (e: any) {
      await writeOperation(
        operatorUserId ?? null,
        OperationType.control_device,
        auditTarget.roomId,
        {
          action: 'turn_off',
          actionLabel: actorContext?.source === 'system_auto' ? '自动断电失败' : '手动断电失败',
          source: actorContext?.source,
          sourceLabel: actorContext?.sourceLabel,
          roomNumber: auditTarget.roomNumber,
          roomName: auditTarget.roomName,
          displayName: auditTarget.displayName,
          deviceName: auditTarget.deviceName,
          did: deviceDid,
          powerAction: 'off',
          error: e?.message || String(e),
        },
        false,
      );
      throw new AppError(
        e instanceof AppError ? e.statusCode : 502,
        e instanceof AppError ? e.code : 'XIAOMI_DEVICE_CONTROL_FAILED',
        e?.message || '米家关闭设备失败',
      );
    }
  }

  public async getRealtimeByRoom(roomId: string): Promise<{
    powerW: number; currentA: number; voltageV: number; totalKwh: number; online: boolean;
  }> {
    const devices = await prisma.device.findMany({ where: { roomId } });
    let totalPowerW = 0;
    let totalKwh = 0;
    let allOnline = devices.length > 0;

    for (const device of devices) {
      const powerW = device.power === true ? (device.powerW ?? 0) : 0;
      totalPowerW += powerW;
      totalKwh += device.totalKwh ?? 0;
      if (device.status !== DeviceStatus.online) allOnline = false;
    }

    if (devices.length === 0) {
      totalPowerW = 0;
    }
    const voltageV = devices.length > 0
      ? (devices.find((d) => d.voltageV != null)?.voltageV ?? 220)
      : 220;
    const currentA = totalPowerW > 0 && voltageV > 0 ? totalPowerW / voltageV : 0;

    return {
      powerW: totalPowerW,
      currentA,
      voltageV,
      totalKwh,
      online: allOnline,
    };
  }

  public async refreshAllRoomsRealtime(): Promise<void> {
    const devices = await this.fetchDevices();
    const [defaultSite, rooms] = await Promise.all([
      prisma.site.findFirst({
        where: { isPrimary: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.room.findMany({
        select: {
          id: true,
          siteId: true,
        },
      }),
    ]);
    const fallbackSiteId = defaultSite?.id;
    if (!fallbackSiteId) {
      throw new Error('系统中尚未配置默认区域，暂时无法刷新实时数据');
    }
    const roomSiteMap = new Map(rooms.map((room) => [room.id, room.siteId]));

    const now = new Date();
    for (const device of devices) {
      const siteId =
        (device.roomId ? roomSiteMap.get(device.roomId) : null) ??
        device.siteId ??
        fallbackSiteId;
      const previous = await prisma.device.findUnique({
        where: { did: device.did },
        select: { powerW: true, currentA: true, voltageV: true, totalKwh: true, power: true },
      }) as DeviceRuntimePrevious | null;
      const safe = sanitizeRuntimeForUpsert(
        {
          powerW: device.powerW,
          currentA: device.currentA,
          voltageV: device.voltageV,
          totalKwh: device.totalKwh,
          online: device.online,
        },
        previous,
      );
      await prisma.device.upsert({
        where: { did: device.did },
        update: {
          siteId,
          name: device.name,
          model: device.model,
          roomId: device.roomId ?? undefined,
          status: (safe.online ? 'online' : 'offline') as DeviceStatus,
          power: safe.power,
          powerW: safe.powerW,
          currentA: safe.currentA,
          voltageV: safe.voltageV,
          totalKwh: safe.totalKwh,
          lastSyncAt: now,
        },
        create: {
          did: device.did,
          siteId,
          name: device.name,
          model: device.model,
          roomId: device.roomId,
          status: (safe.online ? 'online' : 'offline') as DeviceStatus,
          power: safe.power,
          powerW: safe.powerW,
          currentA: safe.currentA,
          voltageV: safe.voltageV,
          totalKwh: safe.totalKwh,
          lastSyncAt: now,
        },
      });
    }

    if (devices.length > 0) {
      const currentDidSet = new Set(devices.map((device) => device.did));
      const existingManagedDevices = await prisma.device.findMany({
        where: {
          NOT: { did: { startsWith: 'LAN_' } },
        },
        select: {
          did: true,
          name: true,
          model: true,
        },
      });

      for (const device of existingManagedDevices) {
        if (currentDidSet.has(device.did)) continue;
        const category = inferDeviceCategory({ name: device.name, model: device.model });
        if (
          category === DeviceCategory.CAMERA ||
          category === DeviceCategory.WIFI_AP ||
          category === DeviceCategory.FIVE_G_CPE
        ) {
          continue;
        }

        await prisma.device.update({
          where: { did: device.did },
          data: {
            status: DeviceStatus.offline,
            power: false,
            powerW: 0,
            currentA: 0,
            lastSyncAt: now,
          },
        });
      }
    }
  }

  public async ensureRealtimeFresh(maxAgeMs: number = 15000): Promise<void> {
    const latestSync = await prisma.device.aggregate({
      _max: { lastSyncAt: true },
    });

    const lastSyncAt = latestSync._max.lastSyncAt;
    if (lastSyncAt && Date.now() - lastSyncAt.getTime() <= maxAgeMs) {
      return;
    }

    if (this.realtimeRefreshPromise) {
      await this.realtimeRefreshPromise;
      return;
    }

    this.realtimeRefreshPromise = this.refreshAllRoomsRealtime()
      .catch((error) => {
        console.warn('[XiaomiAdapter] ensureRealtimeFresh 刷新失败：', error?.message || error);
      })
      .finally(() => {
        this.realtimeRefreshPromise = null;
      });

    await this.realtimeRefreshPromise;
  }

  // ──────────────── MiOT Spec Action generic wrapper ────────────────

  public async callDeviceAction(
    did: string,
    siid: number,
    aiid: number,
    input: any[] = [],
    scope: XiaomiSessionScope = 'main',
  ): Promise<any> {
    const session = await this.getSession(scope);
    if (!session) {
      throw new AppError(400, 'XIAOMI_NOT_LOGGED_IN', `米家${scope === 'camera' ? '摄像头区' : ''}未登录，无法调用设备 Action`);
    }
    if (/^mock_/.test(session.serviceToken)) {
      throw new AppError(400, 'XIAOMI_SESSION_INVALID', `当前米家${scope === 'camera' ? '摄像头区' : ''}会话不是真实会话`);
    }
    const path = '/app/miotspec/action';
    const payload = { did, siid, aiid, in: input };
    const result = await this.requestIo(session, 'POST', path, undefined, payload);
    return result;
  }

  // ──────────────── Camera Spec mapping (MBC23 / C300 / C200 etc.) ────────────────

  private getCameraSpecForModel(model: string): {
    rtsp: { siid: number; aiid_start: number; aiid_stop?: number };
    ptz?: { siid: number; aiid_move: number; aiid_stop?: number };
  } {
    const m = (model || '').toLowerCase();
    // Xiaomi Smart Camera C301 (MBC23) - EU version
    if (m.includes('mbc23') || m.includes('c301') || m.includes('xiaomi.camera.c301')) {
      return {
        rtsp: { siid: 18, aiid_start: 1 },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Xiaomi Outdoor Camera AW200 / AW300
    if (m.includes('aw200') || m.includes('aw300') || m.includes('aw301')) {
      return {
        rtsp: { siid: 18, aiid_start: 1 },
      };
    }
    // Xiaomi Camera C200 (MJSXJ03HL)
    if (m.includes('mjsxj03hl') || m.includes('c200')) {
      return {
        rtsp: { siid: 18, aiid_start: 1 },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Mi Home Security Camera 360° 1080P (MJSXJ05CM / MJSXJ02CM)
    if (m.includes('mjsxj05cm') || m.includes('mjsxj02cm') || m.includes('2k') || m.includes('360')) {
      return {
        rtsp: { siid: 18, aiid_start: 1 },
        ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
      };
    }
    // Default generic camera Spec (shared by most Xiaomi cameras)
    return {
      rtsp: { siid: 18, aiid_start: 1 },
      ptz: { siid: 19, aiid_move: 1, aiid_stop: 2 },
    };
  }

  // ──────────────── Camera: start / stop RTSP stream ────────────────

  public async startRTSPStream(
    did: string,
    model: string = '',
    scope: XiaomiSessionScope = 'camera',
  ): Promise<{
    streamAddress: string;
    streamAuthToken: string;
    rtspUrl: string;
    rawResult: any;
  }> {
    const spec = this.getCameraSpecForModel(model);
    const raw = await this.callDeviceAction(did, spec.rtsp.siid, spec.rtsp.aiid_start, [], scope);
    // Xiaomi usually returns the result in {result: {out: [...]}} or directly as an array
    let outArr: any[] = [];
    if (Array.isArray(raw)) outArr = raw;
    else if (Array.isArray(raw?.out)) outArr = raw.out;
    else if (Array.isArray(raw?.result?.out)) outArr = raw.result.out;
    else if (raw && typeof raw === 'object') {
      const vals = Object.values(raw);
      const arr = vals.find((v: any) => Array.isArray(v)) as any[] | undefined;
      if (arr) outArr = arr;
    }
    // stream_address / stream_auth_token are the first two items of the out array
    const streamAddress = String(
      outArr[0] ?? raw?.stream_address ?? raw?.['stream-address'] ?? raw?.address ?? '',
    ).trim();
    const streamAuthToken = String(
      outArr[1] ?? raw?.stream_auth_token ?? raw?.['stream-auth-token'] ?? raw?.token ?? '',
    ).trim();
    if (!streamAddress) {
      console.error('[XiaomiAdapter] startRTSPStream 未解析到 streamAddress，原始返回：', JSON.stringify(raw).slice(0, 800));
      throw new Error('米家摄像头未返回 stream_address，请确认设备型号与 Spec 映射是否匹配');
    }
    // Build an authenticated RTSP URL (direct LAN, no cloud round-trip)
    let rtspUrl = streamAddress;
    if (streamAuthToken) {
      try {
        const u = new URL(streamAddress);
        u.username = 'admin';
        u.password = streamAuthToken;
        rtspUrl = u.toString();
      } catch {
        rtspUrl = streamAddress.includes('rtsp://')
          ? streamAddress.replace('rtsp://', `rtsp://admin:${encodeURIComponent(streamAuthToken)}@`)
          : streamAddress;
      }
    }
    return {
      streamAddress,
      streamAuthToken,
      rtspUrl,
      rawResult: raw,
    };
  }

  // ──────────────── Camera: PTZ control ────────────────

  public async moveCameraPTZ(
    did: string,
    direction: 'left' | 'right' | 'up' | 'down' | 'stop',
    speed: number = 50,
    model: string = '',
    scope: XiaomiSessionScope = 'camera',
  ): Promise<boolean> {
    const spec = this.getCameraSpecForModel(model);
    if (!spec.ptz) {
      throw new Error(`当前摄像头型号 ${model} 未配置云台 Spec 映射`);
    }
    // PTZ move input:
    // [0] = direction: 0=left,1=right,2=up,3=down, or a string
    // [1] = speed: 0-100
    const dirMap: Record<string, number> = { left: 0, right: 1, up: 2, down: 3 };
    if (direction === 'stop') {
      const aiid = spec.ptz.aiid_stop ?? spec.ptz.aiid_move;
      try {
        await this.callDeviceAction(did, spec.ptz.siid, aiid, [], scope);
        return true;
      } catch {
        await this.callDeviceAction(did, spec.ptz.siid, spec.ptz.aiid_move, [4, 0], scope);
        return true;
      }
    }
    const dirCode = dirMap[direction];
    if (dirCode === undefined) throw new Error(`未知云台方向：${direction}`);
    const speedSafe = Math.max(0, Math.min(100, Number(speed) || 50));
    await this.callDeviceAction(did, spec.ptz.siid, spec.ptz.aiid_move, [dirCode, speedSafe], scope);
    return true;
  }

  // ──────────────── Camera region: fetch camera device list ────────────────

  public async fetchCameraDevices(): Promise<XiaomiDeviceInfo[]> {
    const session = await this.getSession('camera');
    console.info('[XiaomiAdapter.fetchCameraDevices] 诊断入参：', {
      hasSession: !!session,
      region: session?.region ?? null,
      userId: session?.userId ?? null,
      mock: session?.serviceToken ? /^mock_/.test(session.serviceToken) : null,
      apiBase: session ? buildApiBaseUrl(session.region) : null,
    });
    if (!session || /^mock_/.test(session.serviceToken)) {
      return [];
    }
    const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true, name: true } });
    const listReal: XiaomiDeviceInfo[] = [];
    const isIntlRegion = !!(session.region && session.region.toLowerCase() !== 'cn');
    try {
      const ioPathOptions = isIntlRegion
        ? ['/home/device_list', '/app/home/device_list']
        : [DEVICE_LIST_URL.replace(/^https:\/\/api\.io\.mi\.com/, '')];
      const bodyVariants = isIntlRegion
        ? [
          { getVirtualModel: false, getHuamiDevices: 0, getSplitHumanDeviceInfos: 1 },
          { getVirtualModel: true, getHuamiDevices: 1, getSplitHumanDeviceInfos: 1 },
          { getVirtualModel: false, getHuamiDevices: 0 },
        ]
        : [
          { getVirtualModel: false, getHuamiDevices: 0 },
        ];
      let list: RawDevice[] | null = null;
      let finalPath: string | null = null;
      let finalBody: any = null;
      let finalRaw: any = null;
      endpointLoop:
      for (const ioPath of ioPathOptions) {
        const fullUrl = `${buildApiBaseUrl(session.region)}${ioPath.startsWith('/') ? '' : '/'}${ioPath}`;
        for (const body of bodyVariants) {
          console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测尝试：', {
            region: session.region,
            ioPath,
            fullUrl,
            body,
          });
          try {
            const deviceResponse = (await this.requestIo(session, 'POST', ioPath, undefined, body)) as unknown;
            const head = JSON.stringify(deviceResponse ?? {}).slice(0, 1500);
            console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测返回：', { ioPath, body, head });
            const devicePayload = deviceResponse as {
              list?: RawDevice[];
              result?: { list?: RawDevice[]; device_list?: RawDevice[] };
              device_list?: RawDevice[];
            } | RawDevice[] | null;
            const tryList: RawDevice[] | null = Array.isArray(devicePayload)
              ? devicePayload
              : Array.isArray(devicePayload?.list) && devicePayload.list.length > 0
                ? devicePayload.list
                : Array.isArray(devicePayload?.device_list) && devicePayload.device_list.length > 0
                  ? devicePayload.device_list
                  : Array.isArray(devicePayload?.result?.list) && devicePayload.result.list.length > 0
                    ? devicePayload.result.list
                    : Array.isArray(devicePayload?.result?.device_list) && devicePayload.result.device_list.length > 0
                      ? devicePayload.result.device_list
                      : Array.isArray(devicePayload?.list)
                        ? devicePayload.list
                        : Array.isArray(devicePayload?.result?.list)
                          ? devicePayload.result.list
                          : Array.isArray(devicePayload?.result?.device_list)
                            ? devicePayload.result.device_list
                            : Array.isArray(devicePayload?.device_list)
                              ? devicePayload.device_list
                              : null;
            if (tryList && tryList.length > 0) {
              list = tryList;
              finalPath = ioPath;
              finalBody = body;
              finalRaw = deviceResponse;
              break endpointLoop;
            }
            if (!list && tryList) {
              list = tryList;
              finalPath = ioPath;
              finalBody = body;
              finalRaw = deviceResponse;
            }
          } catch (probeErr: any) {
            console.warn('[XiaomiAdapter.fetchCameraDevices] EU 探测失败：', {
              ioPath, body, msg: probeErr?.message,
            });
          }
        }
      }
      console.info('[XiaomiAdapter.fetchCameraDevices] EU 探测完成：', {
        isIntlRegion,
        finalPath,
        finalBody,
        finalLen: list?.length ?? null,
        firstDevice: list && list.length > 0
          ? { did: list[0].did, name: list[0].name, model: list[0].model, isOnline: (list[0] as any).isOnline ?? null }
          : null,
        finalRawKeys: finalRaw && typeof finalRaw === 'object' ? Object.keys(finalRaw as Record<string, any>) : null,
        finalHead: finalRaw ? JSON.stringify(finalRaw).slice(0, 2400) : null,
      });
      if (Array.isArray(list) && list.length > 0) {
        for (let i = 0; i < list.length; i++) {
          const raw = list[i];
          const roomId = this.resolveRoomId(rooms, raw);
          listReal.push({
            did: raw.did,
            name: raw.name ?? raw.model ?? `camera_${i + 1}`,
            model: raw.model ?? 'unknown',
            online: raw.isOnline === true || raw.status === 1,
            roomId,
            localIp: raw.localip,
            sourceRegion: session?.region || 'de',
            sourceScope: 'camera',
          });
        }
      }
    } catch (err: any) {
      console.warn(
        '[XiaomiAdapter] fetchCameraDevices 失败：',
        err?.message,
        '\n  stack=',
        err?.stack ?? '',
      );
    }
    return listReal.sort((a, b) => {
      const aCam = inferDeviceCategory({ name: a.name, model: a.model }) === DeviceCategory.CAMERA ? 0 : 1;
      const bCam = inferDeviceCategory({ name: b.name, model: b.model }) === DeviceCategory.CAMERA ? 0 : 1;
      if (aCam !== bCam) return aCam - bCam;
      return Number(b.online === true) - Number(a.online === true);
    });
  }
}

export const xiaomiAdapter = XiaomiAdapter.getInstance();
export default XiaomiAdapter;
