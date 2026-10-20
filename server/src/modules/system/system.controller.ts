import { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SystemSettingsData } from '@shared/index';
import { systemService } from './system.service';
import { xiaomiAdapter } from './xiaomi.adapter';
import { XIAOMI_USERNAME, XIAOMI_PASSWORD } from '../../config/env';
import { getOperationActorContextFromRequest } from '../../lib/request-context';
import { scanLanDevices, detectLanSubnets, probeLanDevicesDetailed } from '../../lib/lan-scan';
import { AppError } from '../../lib/errors';
import { lanCameraService } from './lan-camera.service';
import { probeOnvifDevice } from './lib/onvif';

// 从 device.model JSON 解析米家云摄像头真实 DID 与会话区；
// 局域网扫描到的摄像头主键是 LAN_ 前缀，米家 API 需要数字 DID（model.xiaomiDid）。
function resolveXiaomiDeviceRef(
  model: string,
  fallbackDid: string,
): { did: string; scope: 'main' | 'camera' } {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = model ? JSON.parse(model) : null;
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
  } catch {
    obj = null;
  }
  const xiaomiDid =
    obj && typeof obj.xiaomiDid === 'string' && obj.xiaomiDid.trim()
      ? obj.xiaomiDid.trim()
      : fallbackDid;
  const scope = obj && obj.sourceScope === 'main' ? 'main' : 'camera';
  return { did: xiaomiDid, scope };
}

export const getSettings = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const settings = await systemService.getSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
};

/** 读取 cloudflared quick tunnel 日志，返回最新的 trycloudflare 公网地址 */
function findLatestTunnelUrl(): { url: string; mtime: number } | null {
  const dir = process.env.CLOUDFLARED_DIR || 'C:\\zaem\\cloudflared';
  if (!fs.existsSync(dir)) return null;
  let newest: { url: string; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('quick-tunnel')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const text = fs.readFileSync(full, 'utf8');
        const matches = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
        if (matches && matches.length > 0) {
          const url = matches[matches.length - 1];
          if (!newest || st.mtimeMs > newest.mtime) newest = { url, mtime: st.mtimeMs };
        }
      } catch {
        /* 忽略单个日志文件读取失败 */
      }
    }
  } catch {
    return null;
  }
  return newest;
}

function isCloudflaredRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe"', {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    return out.toLowerCase().includes('cloudflared.exe');
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let remoteAccessRenewing = false;

/**
 * 远程访问（外网）信息：读取 cloudflared quick tunnel 当前地址。
 * 手机/外网访问本系统时使用该地址；隧道重启后地址可能变化，前端点「更新」重新申请即可。
 */
export const getRemoteAccessInfo = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const latest = findLatestTunnelUrl();
    const running = isCloudflaredRunning();
    const enabled = !!(latest && running);
    res.json({
      enabled,
      url: enabled ? latest!.url : null,
      provider: 'cloudflared',
      checkedAt: new Date().toISOString(),
      ...(enabled ? {} : { hint: '未检测到 cloudflared 隧道（或隧道未运行），可点击「更新」重新申请外网地址。' }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 重新申请外网地址：重启 zaem-tunnel 服务（cloudflared quick tunnel），
 * 等待其生成新的 trycloudflare 地址并返回。用于停电/服务器重启后地址失效的场景。
 */
export const renewRemoteAccess = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  if (process.platform !== 'win32') {
    res.status(400).json({
      ok: false,
      enabled: false,
      url: null,
      provider: 'cloudflared',
      checkedAt: new Date().toISOString(),
      hint: '仅支持 Windows 服务器',
    });
    return;
  }
  if (remoteAccessRenewing) {
    res.status(409).json({
      ok: false,
      enabled: false,
      url: null,
      provider: 'cloudflared',
      checkedAt: new Date().toISOString(),
      hint: '正在更新外网地址，请稍候再试',
    });
    return;
  }
  remoteAccessRenewing = true;
  try {
    const previousTunnelUrl = findLatestTunnelUrl()?.url ?? null;
    try {
      execSync('sc.exe stop zaem-tunnel', { timeout: 30000, windowsHide: true });
    } catch {
      /* 服务可能已经停止 */
    }
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      try {
        const q = execSync('sc.exe query zaem-tunnel', {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
        });
        if (/STOPPED/.test(q)) break;
      } catch {
        break;
      }
    }
    try {
      execSync('sc.exe start zaem-tunnel', { timeout: 30000, windowsHide: true });
    } catch (err: any) {
      throw new Error(`启动外网隧道服务失败：${err?.message || err}`);
    }
    let url: string | null = null;
    const previousUrl = previousTunnelUrl;
    for (let i = 0; i < 75; i += 1) {
      await sleep(1000);
      const latest = findLatestTunnelUrl();
      if (!latest) continue;
      // quick tunnel 重启后一定会分配新地址；等到新地址出现才返回，避免把旧地址当成"更新成功"
      if (latest.url !== previousUrl) {
        url = latest.url;
        break;
      }
    }
    if (!url) {
      const latest = findLatestTunnelUrl();
      if (latest && latest.url !== previousUrl && isCloudflaredRunning()) url = latest.url;
    }
    if (!url) {
      throw new Error('外网隧道已重启，但暂时没拿到新地址，请稍后再点一次「更新」');
    }
    res.json({
      ok: true,
      enabled: true,
      url,
      provider: 'cloudflared',
      checkedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    next(new AppError(500, 'REMOTE_ACCESS_RENEW_FAILED', error?.message || '更新外网地址失败'));
  } finally {
    remoteAccessRenewing = false;
  }
};

export const getSites = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const sites = await systemService.listSites();
    res.json(sites);
  } catch (error) {
    next(error);
  }
};

export const createSite = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const created = await systemService.createSite(
      req.body ?? {},
      req.user!.id,
      getOperationActorContextFromRequest(req),
    );
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
};

export const updateSite = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const updated = await systemService.updateSite(
      req.params.siteId,
      req.body ?? {},
      req.user!.id,
      getOperationActorContextFromRequest(req),
    );
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const updateSettings = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const partial = req.body as Partial<SystemSettingsData>;
    const operatorUserId = req.user!.id;
    const updated = await systemService.updateSettings(
      partial,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const refreshReferencePrice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { region, businessTimezone, autoEnabled } = (req.body ?? {}) as {
      region?: string;
      businessTimezone?: string;
      autoEnabled?: boolean;
    };
    const result = await systemService.refreshReferenceElectricityPrice({
      region,
      businessTimezone,
      autoEnabled,
      operatorUserId: req.user!.id,
      actorContext: getOperationActorContextFromRequest(req),
      writeOperationLog: true,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ──────────────── 局域网设备详情探测（端口 / 品牌 / 类型 / MiIO 能力） ────────────────
export const lanDeviceProbe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      items?: Array<{ ip: string; mac?: string | null; vendor?: string | null; name?: string | null; hostname?: string | null }>;
      ips?: string[];
    };
    const items: Array<{ ip: string; mac?: string | null; vendor?: string | null; name?: string | null; hostname?: string | null }> = [];
    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        if (item && typeof item.ip === 'string' && item.ip.trim()) {
          items.push({
            ip: item.ip.trim(),
            mac: item.mac ?? null,
            vendor: item.vendor ?? null,
            name: item.name ?? null,
            hostname: item.hostname ?? null,
          });
        }
      }
    } else if (Array.isArray(body.ips)) {
      for (const ip of body.ips) {
        if (typeof ip === 'string' && ip.trim()) items.push({ ip: ip.trim() });
      }
    }
    if (items.length === 0) {
      res.status(400).json({ code: 'ITEMS_REQUIRED', message: '请提供要探测的设备 IP 列表' });
      return;
    }
    if (items.length > 128) {
      res.status(400).json({ code: 'TOO_MANY_ITEMS', message: '一次最多探测 128 台设备' });
      return;
    }
    const devices = await probeLanDevicesDetailed(items);
    res.json({ total: devices.length, devices });
  } catch (error) {
    next(error);
  }
};

// ──────────────── 手动添加设备（统一添加设备向导） ────────────────
export const manualAddDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      name?: string;
      ip?: string;
      mac?: string | null;
      category?: string;
      vendor?: string | null;
      model?: string | null;
      roomId?: string | null;
    };
    const result = await systemService.upsertManualDevice(
      {
        name: String(body.name ?? ''),
        ip: String(body.ip ?? ''),
        mac: body.mac ?? null,
        category: String(body.category ?? ''),
        vendor: body.vendor ?? null,
        model: body.model ?? null,
        roomId: typeof body.roomId === 'string' ? body.roomId : null,
      },
      req.user?.id ?? null,
      getOperationActorContextFromRequest(req),
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

export const xiaomiStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loggedIn = await xiaomiAdapter.isLoggedIn();
    const authStatus = await xiaomiAdapter.getAuthStatus();
    const hasEnvCredentials = !!(XIAOMI_USERNAME && XIAOMI_PASSWORD);
    // #region debug-point D:controller-status-response
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
          location: 'system.controller.ts:xiaomiStatus',
          msg: '[DEBUG] xiaomi status response prepared',
          data: {
            loggedIn,
            authState: authStatus?.state ?? null,
            needsVerification: authStatus?.needsVerification ?? null,
            hasNotificationUrl: !!authStatus?.notificationUrl,
            username: authStatus?.username ?? null,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion
    res.json({
      loggedIn,
      hasEnvCredentials,
      username:
        authStatus?.username ||
        (hasEnvCredentials ? XIAOMI_USERNAME ?? '已配置账号' : undefined),
      auth: authStatus,
    });
  } catch (error) {
    next(error);
  }
};

export const xiaomiDevices = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loggedIn = await xiaomiAdapter.isLoggedIn('main');
    const authStatus = await xiaomiAdapter.getAuthStatus('main');
    const sessionSnap = await xiaomiAdapter.peekSession('main');
    const region = sessionSnap?.region || (authStatus as any)?.region || 'cn';
    const username = sessionSnap?.username || authStatus?.username || undefined;
    const devices = loggedIn ? await xiaomiAdapter.fetchDevices() : [];
    res.json({
      loggedIn,
      region,
      username,
      auth: authStatus,
      devices,
    });
  } catch (error) {
    next(error);
  }
};

export const xiaomiLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      username,
      password,
      userId,
      serviceToken,
      ssecurity,
      region,
      continueAfterVerification,
      sendEmailVerificationCode,
      verificationCode,
    } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      userId?: string;
      serviceToken?: string;
      ssecurity?: string;
      region?: string;
      continueAfterVerification?: boolean;
      sendEmailVerificationCode?: boolean;
      verificationCode?: string;
    };

    if (sendEmailVerificationCode) {
      const sent = await xiaomiAdapter.sendEmailVerificationCode('main');
      res.json({
        sent,
        usedEnv: false,
        loginMode: 'password',
        verificationMethod: 'email_code',
      });
      return;
    }

    if (verificationCode) {
      try {
        const success = await xiaomiAdapter.verifyEmailCode(verificationCode, 'main');
        res.json({
          loggedIn: success,
          usedEnv: false,
          loginMode: 'password',
          verificationMethod: 'email_code',
        });
      } catch (error: any) {
        res.status(400).json({
          code: 'XIAOMI_VERIFY_EMAIL_CODE_FAILED',
          message: error?.message || '米家验证码校验失败',
          usedEnv: false,
          loginMode: 'password',
          verificationMethod: 'email_code',
        });
      }
      return;
    }

    if (continueAfterVerification) {
      // #region debug-point A:controller-continue-request
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
            hypothesisId: 'A',
            location: 'system.controller.ts:xiaomiLogin:continue-request',
            msg: '[DEBUG] continue login request entered controller',
            data: {
              hasUsername: !!username,
              continueAfterVerification: !!continueAfterVerification,
              path: req.path,
            },
            ts: Date.now(),
          }),
        }).catch(() => {});
      })();
      // #endregion
      try {
        const success = await xiaomiAdapter.continueLogin();
        // #region debug-point D:controller-continue-success
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
              location: 'system.controller.ts:xiaomiLogin:continue-success',
              msg: '[DEBUG] continue login succeeded in controller',
              data: { success },
              ts: Date.now(),
            }),
          }).catch(() => {});
        })();
        // #endregion
        res.json({ loggedIn: success, usedEnv: false, loginMode: 'password' });
      } catch (error: any) {
        // #region debug-point C:controller-continue-failed
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
              location: 'system.controller.ts:xiaomiLogin:continue-failed',
              msg: '[DEBUG] continue login failed in controller',
              data: { message: error?.message || String(error) },
              ts: Date.now(),
            }),
          }).catch(() => {});
        })();
        // #endregion
        res.status(400).json({
          code: 'XIAOMI_CONTINUE_LOGIN_FAILED',
          message: error?.message || '米家继续登录失败',
          usedEnv: false,
          loginMode: 'password',
        });
      }
      return;
    }

    const useSessionInput = !!(userId && serviceToken && ssecurity);
    // #region debug-point A:controller-login-branch
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
          hypothesisId: 'A',
          location: 'system.controller.ts:xiaomiLogin:branch',
          msg: '[DEBUG] received xiaomi login request',
          data: {
            hasUsername: !!username,
            hasPassword: !!password,
            hasUserId: !!userId,
            hasServiceToken: !!serviceToken,
            hasSsecurity: !!ssecurity,
            useSessionInput,
          },
          ts: Date.now(),
        }),
      }).catch(() => {});
    })();
    // #endregion

    if (useSessionInput) {
      try {
        const success = await xiaomiAdapter.loginWithSession({
          username,
          userId,
          serviceToken,
          ssecurity,
          region,
        });
        // #region debug-point D:controller-session-success
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
              location: 'system.controller.ts:xiaomiLogin:session-success',
              msg: '[DEBUG] session login succeeded in controller',
              data: { username: username || null },
              ts: Date.now(),
            }),
          }).catch(() => {});
        })();
        // #endregion
        res.json({ loggedIn: success, usedEnv: false, loginMode: 'session' });
      } catch (error: any) {
        // #region debug-point B:controller-session-failed
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
              hypothesisId: 'B',
              location: 'system.controller.ts:xiaomiLogin:session-failed',
              msg: '[DEBUG] session login failed in controller',
              data: { message: error?.message || String(error) },
              ts: Date.now(),
            }),
          }).catch(() => {});
        })();
        // #endregion
        res.status(400).json({
          code: 'XIAOMI_SESSION_LOGIN_FAILED',
          message: error?.message || '米家会话串登录失败',
          usedEnv: false,
          loginMode: 'session',
        });
      }
      return;
    }

    const useEnv = !username || !password;
    const finalUser = useEnv ? XIAOMI_USERNAME : username;
    const finalPass = useEnv ? XIAOMI_PASSWORD : password;

    if (!finalUser || !finalPass) {
      res.status(400).json({
        code: 'XIAOMI_CREDENTIALS_REQUIRED',
        message:
          '未找到米家账号配置，请先在 server/.env 或 docker-compose.yml environment 中设置 XIAOMI_USERNAME 与 XIAOMI_PASSWORD',
      });
      return;
    }

    try {
      const success = await xiaomiAdapter.login(finalUser, finalPass, 'main', region || 'cn');
      // #region debug-point D:controller-password-success
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
            location: 'system.controller.ts:xiaomiLogin:password-success',
            msg: '[DEBUG] password login succeeded in controller',
            data: { useEnv, username: finalUser || null },
            ts: Date.now(),
          }),
        }).catch(() => {});
      })();
      // #endregion
      res.json({ loggedIn: success, usedEnv: useEnv, loginMode: 'password' });
    } catch (error: any) {
      // #region debug-point C:controller-password-failed
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
            location: 'system.controller.ts:xiaomiLogin:password-failed',
            msg: '[DEBUG] password login failed in controller',
            data: { useEnv, message: error?.message || String(error) },
            ts: Date.now(),
          }),
        }).catch(() => {});
      })();
      // #endregion
      res.status(400).json({
        code: 'XIAOMI_LOGIN_FAILED',
        message: error?.message || '米家登录失败',
        usedEnv: useEnv,
        loginMode: 'password',
      });
    }
  } catch (error) {
    next(error);
  }
};

export const xiaomiSync = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const operatorUserId = req.user!.id;
    try {
      const success = await systemService.syncXiaomiDevices(
        operatorUserId,
        getOperationActorContextFromRequest(req),
      );
      res.json({ synced: success });
    } catch (error: any) {
      res.status(400).json({
        code: 'XIAOMI_SYNC_FAILED',
        message: error?.message || '米家同步失败',
      });
    }
  } catch (error) {
    next(error);
  }
};

export const controlDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { action } = (req.body ?? {}) as { action?: 'on' | 'off' };
    const operatorUserId = req.user!.id;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 did' });
      return;
    }
    if (action !== 'on' && action !== 'off') {
      res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须是 on 或 off' });
      return;
    }
    // 局域网设备（已配置 localip + controlProtocol）走本地适配器，不依赖厂商云
    const localDevice = await systemService.getLocalControlDevice(did);
    if (localDevice?.controlProtocol && localDevice.localip) {
      const result = await systemService.controlLocalLanDevice(
        did,
        action,
        operatorUserId,
        getOperationActorContextFromRequest(req),
      );
      res.json({ ok: true, did, action, mode: result.mode });
      return;
    }
    if (action === 'on') {
      await xiaomiAdapter.turnOn(did, operatorUserId, getOperationActorContextFromRequest(req));
    } else {
      await xiaomiAdapter.turnOff(did, operatorUserId, getOperationActorContextFromRequest(req));
    }
    res.json({ ok: true, did, action });
  } catch (error) {
    next(error);
  }
};

export const getDeviceControlConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 did' });
      return;
    }
    const result = await systemService.getDeviceControlConfig(did);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const updateDeviceControlConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const body = (req.body ?? {}) as {
      localip?: string;
      controlProtocol?: string;
      controlConfig?: unknown;
    };
    const operatorUserId = req.user!.id;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 did' });
      return;
    }
    const result = await systemService.saveDeviceControlConfig(
      did,
      body,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const testDeviceControlConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const body = (req.body ?? {}) as {
      localip?: string;
      controlProtocol?: string;
      controlConfig?: unknown;
      action?: 'on' | 'off';
    };
    void did;
    const result = await systemService.testDeviceControlConfig(body);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const renameDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { name } = (req.body ?? {}) as { name?: string };
    const operatorUserId = req.user!.id;

    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 did' });
      return;
    }

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ code: 'NAME_REQUIRED', message: '设备名称不能为空' });
      return;
    }

    if (name.trim().length > 8) {
      res.status(400).json({ code: 'NAME_TOO_LONG', message: '设备名称最多 8 个字' });
      return;
    }

    const updated = await systemService.renameDevice(
      did,
      name,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const updateRoomAnnotation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { roomId } = req.params;
    const { annotation } = (req.body ?? {}) as { annotation?: string };
    const operatorUserId = req.user!.id;

    if (!roomId) {
      res.status(400).json({ code: 'ROOM_ID_REQUIRED', message: '缺少房间 ID' });
      return;
    }

    if (typeof annotation !== 'string') {
      res.status(400).json({ code: 'ANNOTATION_REQUIRED', message: '备注内容格式不正确' });
      return;
    }

    if (annotation.trim().length > 8) {
      res.status(400).json({ code: 'ANNOTATION_TOO_LONG', message: '房间名称最多 8 个字' });
      return;
    }

    const updated = await systemService.updateRoomAnnotation(
      roomId,
      annotation,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const updateRoomFloor = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { roomId } = req.params;
    const { floor } = (req.body ?? {}) as { floor?: number | string };
    const operatorUserId = req.user!.id;

    if (!roomId) {
      res.status(400).json({ code: 'ROOM_ID_REQUIRED', message: '缺少房间 ID' });
      return;
    }

    const floorNum = Number(floor);
    if (!Number.isFinite(floorNum)) {
      res.status(400).json({ code: 'FLOOR_INVALID', message: '楼层格式不正确' });
      return;
    }

    const updated = await systemService.updateRoomFloor(
      roomId,
      floorNum,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(updated);
  } catch (error) {
    next(error);
  }
};

export const bulkControlDevices = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { action, siteId } = (req.body ?? {}) as {
      action?: 'on' | 'off';
      siteId?: string;
    };
    const operatorUserId = req.user!.id;

    if (action !== 'on' && action !== 'off') {
      res.status(400).json({ code: 'INVALID_ACTION', message: 'action 必须是 on 或 off' });
      return;
    }

    const result = await systemService.bulkControlDevices(
      action,
      operatorUserId,
      getOperationActorContextFromRequest(req),
      typeof siteId === 'string' && siteId.trim() ? siteId.trim() : undefined,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const detectLanSubnet = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const subnets = await detectLanSubnets();
    res.json({ subnets });
  } catch (error) {
    next(error);
  }
};

// ─── LAN 扫描历史：每次扫描落库一条记录，随时回看/补加设备 ───
const LAN_SCAN_HISTORY_KEY = 'lan_scan_history';
const LAN_SCAN_HISTORY_MAX = 20;

async function recordLanScanHistory(subnet: string, result: any): Promise<void> {
  const entry = {
    id: `scan_${Date.now()}`,
    scannedAt: new Date().toISOString(),
    subnet,
    deviceCount: Array.isArray(result?.devices) ? result.devices.length : 0,
    aliveCount: Number(result?.aliveCount ?? 0),
    arpCount: Number(result?.arpCount ?? 0),
    devices: Array.isArray(result?.devices) ? result.devices : [],
  };
  await systemService.prismaWrap(async (p) => {
    const existing = await p.systemSettings.findUnique({
      where: { key: LAN_SCAN_HISTORY_KEY },
      select: { value: true },
    });
    let list: any[] = [];
    if (existing?.value) {
      try {
        const parsed = JSON.parse(existing.value);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
    }
    const next = [entry, ...list].slice(0, LAN_SCAN_HISTORY_MAX);
    const serialized = JSON.stringify(next);
    await p.systemSettings.upsert({
      where: { key: LAN_SCAN_HISTORY_KEY },
      create: {
        key: LAN_SCAN_HISTORY_KEY,
        value: serialized,
        description: '局域网扫描历史记录（最近 20 次）',
      },
      update: { value: serialized },
    });
  });
}

export const listLanScanHistory = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const row = await systemService.prismaWrap(async (p) =>
      p.systemSettings.findUnique({ where: { key: LAN_SCAN_HISTORY_KEY }, select: { value: true } }),
    );
    let items: any[] = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [];
      }
    }
    res.json({ items });
  } catch (error) {
    next(error);
  }
};

export const clearLanScanHistory = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await systemService.prismaWrap(async (p) =>
      p.systemSettings.upsert({
        where: { key: LAN_SCAN_HISTORY_KEY },
        create: { key: LAN_SCAN_HISTORY_KEY, value: '[]', description: '局域网扫描历史记录（最近 20 次）' },
        update: { value: '[]' },
      }),
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
};

export const lanScan = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  let finished = false;
  const finalize = () => { finished = true; };
  try {
    req.setTimeout(240_000);
    const controller = new AbortController();
    const hardTimeout = setTimeout(() => {
      controller.abort();
      if (!finished) {
        finished = true;
        if (!res.headersSent) {
          res.status(408).json({
            code: 'LAN_SCAN_TIMEOUT',
            message: '超时：后端扫描超过 240 秒仍未完成，已强制停止。可尝试缩小掩码范围（例如改为 /27 先扫小网段）或降低并发。',
          });
        }
      }
    }, 240_000);

    res.on('close', () => {
      try { controller.abort(); } catch { /* noop */ }
      clearTimeout(hardTimeout);
    });

    const { subnet, withHostname, withVendorRemoteApi, pingTimeoutMs, concurrency } = (req.body ?? {}) as {
      subnet?: string
      withHostname?: boolean
      withVendorRemoteApi?: boolean
      pingTimeoutMs?: number
      concurrency?: number
    };

    if (!subnet || !subnet.trim()) {
      clearTimeout(hardTimeout);
      res.status(400).json({
        code: 'SUBNET_REQUIRED',
        message: '请填写扫描网段，例如 192.168.41.0/24',
      });
      return;
    }

    const result = await scanLanDevices({
      subnet: subnet.trim(),
      withHostname: withHostname !== false,
      withVendorRemoteApi: !!withVendorRemoteApi,
      pingTimeoutMs: typeof pingTimeoutMs === 'number' && pingTimeoutMs > 0 ? pingTimeoutMs : undefined,
      concurrency: typeof concurrency === 'number' && concurrency > 0 ? concurrency : undefined,
      abortSignal: controller.signal,
    });

    // 扫描一次记录一次（失败不影响扫描结果返回）
    try {
      await recordLanScanHistory(subnet.trim(), result);
    } catch (historyError) {
      console.warn('[lan-scan] 保存扫描记录失败:', (historyError as Error)?.message);
    }

    clearTimeout(hardTimeout);
    if (finished) return;
    finished = true;
    if (!res.headersSent) {
      res.json(result);
    }
  } catch (error: any) {
    if (finished) return;
    finished = true;
    const m = (error?.message as string) || '局域网扫描失败，请检查网段格式';
    if (!res.headersSent) {
      if (error && (error.name === 'AbortError' || /abort|cancel/i.test(m))) {
        res.status(408).json({
          code: 'LAN_SCAN_TIMEOUT',
          message: `超时：后端扫描已强制停止。${m}`,
        });
      } else {
        res.status(400).json({
          code: 'LAN_SCAN_FAILED',
          message: m,
        });
      }
    }
  } finally {
    finalize();
  }
};

export const persistLanDevices = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { items } = (req.body ?? {}) as {
      items?: Array<{
        ip: string;
        mac: string | null;
        vendor?: string | null;
        name?: string | null;
        hostname?: string | null;
        status?: 'online' | 'offline' | 'unknown';
        siteId?: string | null;
        roomId?: string | null;
      }>;
    };
    if (!Array.isArray(items)) {
      res.status(400).json({ code: 'ITEMS_REQUIRED', message: '缺少 items 数组' });
      return;
    }
    const result = await systemService.persistLanDevices(
      items,
      (req.user as any)?.id ?? null,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const getDeviceSnapshot = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const did = String(req.params.did ?? '').trim();
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const result = await systemService.getDeviceSnapshot(did);
    if (!result) {
      res.status(404).json({ code: 'DEVICE_NOT_FOUND', message: '未找到该设备' });
      return;
    }
    const cacheSafe = String(req.query.cache ?? '').toLowerCase();
    if (!cacheSafe || cacheSafe === 'false' || cacheSafe === 'no-cache') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=5');
    }
    if (result.tried?.length && result.lastErrorMessage) {
      res.setHeader('X-ZAEM-Snapshot-Tried', String(result.tried.length));
      res.setHeader('X-ZAEM-Snapshot-Error', String(result.lastErrorMessage).slice(0, 240));
    }
    res.setHeader('Content-Type', result.contentType || 'image/jpeg');
    res.end(result.buffer);
  } catch (error) {
    next(error);
  }
};

export const updateDeviceCamera = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const body = (req.body ?? {}) as any;
    const operatorUserId = req.user!.id;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const result = await systemService.updateDeviceCamera(
      did,
      {
        manualSnapshotUrl: body.manualSnapshotUrl,
        manualAuthUsername: body.manualAuthUsername,
        manualAuthPassword: body.manualAuthPassword,
        manualAuthType: body.manualAuthType ?? null,
        manualBrand: body.manualBrand,
        manualModel: body.manualModel,
      },
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const updateDeviceCategory = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { category } = (req.body ?? {}) as { category?: string };
    const operatorUserId = req.user!.id;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    if (typeof category !== 'string' || !category.trim()) {
      res.status(400).json({ code: 'CATEGORY_REQUIRED', message: '缺少设备分类' });
      return;
    }
    const result = await systemService.updateDeviceCategory(
      did,
      category.trim(),
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const deleteDevice = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const operatorUserId = req.user!.id;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const result = await systemService.deleteDevice(
      did,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera region: independent session login ────────────────
export const xiaomiCameraLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      username,
      password,
      userId,
      serviceToken,
      ssecurity,
      region,
      sendEmailVerificationCode,
      verificationCode,
      continueAfterVerification,
    } = (req.body ?? {}) as {
      username?: string;
      password?: string;
      userId?: string;
      serviceToken?: string;
      ssecurity?: string;
      region?: string;
      sendEmailVerificationCode?: boolean;
      verificationCode?: string;
      continueAfterVerification?: boolean;
    };

    if (sendEmailVerificationCode) {
      const sent = await xiaomiAdapter.sendEmailVerificationCode('camera');
      const authStatus = await xiaomiAdapter.getAuthStatus('camera');
      res.json({
        sent,
        usedEnv: false,
        loginMode: 'password' as const,
        scope: 'camera' as const,
        verificationMethod: 'email_code' as const,
        auth: authStatus,
      });
      return;
    }

    if (verificationCode) {
      try {
        const success = await xiaomiAdapter.verifyEmailCode(verificationCode, 'camera');
        const loggedInNow =
          success === true ? true : await xiaomiAdapter.isLoggedIn('camera');
        const authStatus = await xiaomiAdapter.getAuthStatus('camera');
        res.json({
          loggedIn: loggedInNow,
          usedEnv: false,
          loginMode: 'password' as const,
          scope: 'camera' as const,
          verificationMethod: 'email_code' as const,
          auth: authStatus,
        });
      } catch (inner: any) {
        const authStatus = await xiaomiAdapter.getAuthStatus('camera');
        res.status(400).json({
          code: 'XIAOMI_CAMERA_VERIFY_EMAIL_CODE_FAILED',
          message: inner?.message || '米家 EU 账号邮箱验证码校验失败',
          usedEnv: false,
          loginMode: 'password' as const,
          scope: 'camera' as const,
          verificationMethod: 'email_code' as const,
          auth: authStatus,
        });
      }
      return;
    }

    if (continueAfterVerification) {
      try {
        const success = await xiaomiAdapter.continueLogin('camera');
        const authStatus = await xiaomiAdapter.getAuthStatus('camera');
        res.json({
          loggedIn: success,
          usedEnv: false,
          loginMode: 'password' as const,
          scope: 'camera' as const,
          verificationMethod: authStatus?.verificationMethod ?? null,
          auth: authStatus,
        });
      } catch (inner: any) {
        const authStatus = await xiaomiAdapter.getAuthStatus('camera').catch(() => null);
        res.status(400).json({
          code: 'XIAOMI_CAMERA_CONTINUE_LOGIN_FAILED',
          message: inner?.message || '米家 EU 账号继续登录失败',
          usedEnv: false,
          loginMode: 'password' as const,
          scope: 'camera' as const,
          verificationMethod: authStatus?.verificationMethod ?? null,
          auth: authStatus ?? undefined,
        });
      }
      return;
    }

    const useSessionInput = !!(userId && serviceToken && ssecurity);
    if (useSessionInput) {
      const success = await xiaomiAdapter.loginWithSession(
        { username, userId, serviceToken, ssecurity, region },
        'camera',
      );
      const authStatus = await xiaomiAdapter.getAuthStatus('camera');
      res.json({ loggedIn: success, loginMode: 'session', scope: 'camera', auth: authStatus });
      return;
    }
    if (username && password) {
      const success = await xiaomiAdapter.login(username, password, 'camera', region);
      const authStatus = await xiaomiAdapter.getAuthStatus('camera');
      res.json({
        loggedIn: success,
        loginMode: 'password',
        scope: 'camera',
        usedEnv: false,
        auth: authStatus,
      });
      return;
    }
    const envUser = process.env.XIAOMI_CAMERA_USERNAME;
    const envPass = process.env.XIAOMI_CAMERA_PASSWORD;
    if (envUser && envPass) {
      const success = await xiaomiAdapter.login(undefined, undefined, 'camera', region);
      const authStatus = await xiaomiAdapter.getAuthStatus('camera');
      res.json({
        loggedIn: success,
        loginMode: 'password',
        scope: 'camera',
        usedEnv: true,
        auth: authStatus,
      });
      return;
    }
    res.status(400).json({
      code: 'CAMERA_CREDENTIALS_REQUIRED',
      message: '请在欧洲区登录卡片里输入账号密码，或在 server/.env 单独配置 XIAOMI_CAMERA_USERNAME / XIAOMI_CAMERA_PASSWORD',
    });
  } catch (error: any) {
    const authStatus = await xiaomiAdapter.getAuthStatus('camera').catch(() => null);
    res.status(400).json({
      code: 'XIAOMI_CAMERA_LOGIN_FAILED',
      message: error?.message || '米家摄像头区登录失败',
      usedEnv: false,
      loginMode: 'password',
      scope: 'camera',
      auth: authStatus ?? undefined,
      needsVerification: authStatus?.needsVerification ?? null,
      verificationMethod: authStatus?.verificationMethod ?? null,
      notificationUrl: authStatus?.notificationUrl ?? null,
    });
  }
};

// ──────────────── Camera region: send email verification code ────────────────
export const xiaomiCameraSendEmailCode = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const sent = await xiaomiAdapter.sendEmailVerificationCode('camera');
    const authStatus = await xiaomiAdapter.getAuthStatus('camera');
    res.json({
      sent,
      scope: 'camera',
      verificationMethod: 'email_code' as const,
      auth: authStatus,
    });
  } catch (error: any) {
    const authStatus = await xiaomiAdapter.getAuthStatus('camera').catch(() => null);
    res.status(400).json({
      sent: false,
      scope: 'camera',
      verificationMethod: 'email_code' as const,
      message: error?.message || '米家 EU 账号发送邮箱验证码失败',
      code: error?.code || 'XIAOMI_CAMERA_SEND_EMAIL_CODE_FAILED',
      auth: authStatus ?? undefined,
    });
  }
};

// ──────────────── Camera region: verify email code and complete login ────────────────
export const xiaomiCameraVerifyEmailCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { verificationCode } = (req.body ?? {}) as { verificationCode?: string };
    if (!verificationCode?.trim()) {
      res.status(400).json({
        code: 'CAMERA_VERIFICATION_CODE_REQUIRED',
        message: '请输入邮箱验证码',
      });
      return;
    }
    const success = await xiaomiAdapter.verifyEmailCode(verificationCode, 'camera');
    const loggedInNow =
      success === true ? true : await xiaomiAdapter.isLoggedIn('camera');
    const authStatus = await xiaomiAdapter.getAuthStatus('camera');
    res.json({
      loggedIn: loggedInNow,
      scope: 'camera',
      verificationMethod: 'email_code' as const,
      auth: authStatus,
    });
  } catch (error: any) {
    const authStatus = await xiaomiAdapter.getAuthStatus('camera').catch(() => null);
    res.status(400).json({
      code: 'XIAOMI_CAMERA_VERIFY_EMAIL_CODE_FAILED',
      message: error?.message || '米家 EU 账号邮箱验证码校验失败',
      scope: 'camera',
      verificationMethod: 'email_code' as const,
      auth: authStatus ?? undefined,
    });
  }
};

// ──────────────── Camera: start RTSP stream + return HLS/WebRTC address ────────────────
export const getCameraStream = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { did: true, model: true, name: true } }),
    );
    const model = device?.model ?? '';
    const name = device?.name ?? '';
    // 局域网（ONVIF/RTSP）摄像头：本地 ffmpeg HLS 代理，完全不依赖小米云
    const lanConfig = await lanCameraService.getLanCameraConfig(did).catch(() => null);
    if (lanConfig) {
      const lanStream = await lanCameraService.ensureLanCameraStream(did, {
        fresh: String(req.query.cache ?? '') === 'no-cache',
      });
      res.json({
        did,
        name,
        model: lanConfig.model ?? lanConfig.brand ?? 'LAN Camera',
        streamAddress: lanStream.rtspUrl,
        streamAuthToken: '',
        rtspUrl: lanStream.rtspUrl,
        hlsUrl: lanStream.hlsUrl,
        hlsReady: lanStream.hlsReady,
        proxyMode: lanStream.proxyMode,
        startedAt: lanStream.startedAt,
        processId: lanStream.processId,
        ffmpegAvailable: lanStream.ffmpegAvailable,
        errorMessage: lanStream.errorMessage,
      });
      return;
    }
    // 米家云摄像头需使用其数字 DID（存储在 model.xiaomiDid），而非局域网 LAN_ 前缀主键
    const xiaomiDevice = resolveXiaomiDeviceRef(model, did);
    // cache=no-cache：前端重连时强制新建云端会话，避免复用已失效的 HLS URL
    const fresh = String(req.query.cache ?? '') === 'no-cache';
    if (fresh) {
      xiaomiAdapter.invalidateHlsCache(xiaomiDevice.did, xiaomiDevice.scope);
    }
    // ① 优先宿主机本地 go2rtc 桥（小米 P2P 私流 → 本地 RTSP → ffmpeg 转 H.264 HLS）：
    //    低延迟、局域网直连、无云端转码，浏览器可直接播放
    const localRtsp = await systemService.resolveLocalGo2rtcRtsp(xiaomiDevice.did);
    if (localRtsp) {
      const streamUrls = await systemService.ensureCameraStreamProxy(did, localRtsp, {
        model,
        name,
        transcodeH264: true,
      });
      if (streamUrls.processId) {
        const ready = await systemService.waitForHlsReadyOrExit(did, 8000);
        if (ready) {
          res.json({
            did,
            model,
            streamAddress: '',
            streamAuthToken: '',
            rtspUrl: localRtsp,
            ...streamUrls,
            hlsReady: true,
          });
          return;
        }
      }
      // go2rtc 本地桥拉流失败 → 落到云端路径
      console.warn('[CameraStream] go2rtc bridge did not produce live HLS, did=', did);
      // 停掉局域网代理，避免它与下方云端代理同时写同一个 HLS 目录互相覆盖
      systemService.stopCameraStreamProxy(did);
    }
    // ② 云端 HLS 本地代理（Google Home 转码流）：
    //    服务端用 ffmpeg 持续拉云端 HLS 并重切为本地稳定流（streams/hls/<did>/stream.m3u8），
    //    云端会话因 CDN 间歇失效/URL 时效中断时自动重建会话续流，浏览器只连本地流。
    try {
      const proxy = await systemService.ensureCloudHlsProxy(xiaomiDevice.did, xiaomiDevice.scope);
      if (proxy.hlsUrl) {
        // hlsReady=false 时不下发 hlsUrl：避免前端请求一个已不存在的 m3u8（404），
        // 前端据此显示"视频流正在恢复"并继续轮询，后端代理会在后台自愈。
        res.json({
          did,
          model,
          name,
          streamAddress: '',
          streamAuthToken: '',
          rtspUrl: '',
          hlsUrl: proxy.hlsReady ? proxy.hlsUrl : null,
          webrtcUrl: null,
          hlsReady: proxy.hlsReady,
          proxyMode: proxy.proxyMode,
          startedAt: null,
          processId: null,
          ffmpegAvailable: true,
          errorMessage: proxy.hlsReady ? undefined : (proxy.errorMessage ?? '视频流正在恢复'),
        });
        return;
      }
      console.warn('[CameraStream] cloud HLS proxy returned no URL, did=', did);
    } catch (e2: any) {
      console.warn('[CameraStream] cloud HLS proxy failed', e2?.message || e2);
    }
    // ③ 云端 RTSP → 本地 ffmpeg 转 HLS（低延迟路径，尽力而为）。
    //    ffmpeg 连接云端 rtsps 可能 EOF/超时；仅作为云端 HLS 失效时的补充尝试。
    try {
      const rtspInfo = await xiaomiAdapter.startRTSPStream(xiaomiDevice.did, model, xiaomiDevice.scope);
      const streamUrls = await systemService.ensureCameraStreamProxy(did, rtspInfo.rtspUrl, {
        model,
        name,
        // 云端 RTSP 为 H265，浏览器 hls.js 不支持；转码 H264 + 短关键帧才能实现 0.5s 低延迟切片
        transcodeH264: true,
      });
      if (streamUrls.processId) {
        const ready = await systemService.waitForHlsReadyOrExit(did, 6000);
        if (ready) {
          res.json({
            did,
            model,
            streamAddress: rtspInfo.streamAddress,
            streamAuthToken: rtspInfo.streamAuthToken ? '***REDACTED***' : '',
            rtspUrl: rtspInfo.streamAddress,
            ...streamUrls,
            hlsReady: true,
          });
          return;
        }
      }
      console.warn('[CameraStream] ffmpeg did not produce live HLS (cloud RTSP), did=', did);
    } catch (e: any) {
      console.warn('[CameraStream] cloud RTSP path failed', e?.message || e);
    }
    throw new AppError(502, 'CAMERA_STREAM_UNAVAILABLE', '摄像头实时流不可用，请稍后重试');
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: PTZ control ────────────────
export const controlCameraPTZ = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { direction, speed } = (req.body ?? {}) as {
      direction?: 'left' | 'right' | 'up' | 'down' | 'stop' | 'calibrate';
      speed?: number;
    };
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    if (!direction || !['left', 'right', 'up', 'down', 'stop', 'calibrate'].includes(direction)) {
      res.status(400).json({
        code: 'INVALID_DIRECTION',
        message: 'direction 必须是 left / right / up / down / stop / calibrate',
      });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true } }),
    );
    const xiaomiDevice = resolveXiaomiDeviceRef(device?.model ?? '', did);
    // 云台回中/校准：C301 云端仅支持 ptz-calibrate 动作，无方向控制
    if (direction === 'calibrate') {
      const ok = await xiaomiAdapter.calibrateCameraPTZ(xiaomiDevice.did, xiaomiDevice.scope);
      res.json({ ok: !!ok, did, direction, speed: 0 });
      return;
    }
    const ok = await xiaomiAdapter.moveCameraPTZ(
      xiaomiDevice.did,
      direction,
      typeof speed === 'number' ? speed : 50,
      device?.model ?? '',
      xiaomiDevice.scope,
    );
    res.json({ ok: !!ok, did, direction, speed: typeof speed === 'number' ? speed : 50 });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: MiOT V1 token (for go2rtc local pull) ────────────────
export const getCameraMiotToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true } }),
    );
    const xiaomiDevice = resolveXiaomiDeviceRef(device?.model ?? '', did);
    const token = await xiaomiAdapter.getDeviceMiotToken(xiaomiDevice.did, xiaomiDevice.scope);
    if (!token) {
      res.status(502).json({ code: 'TOKEN_FETCH_FAILED', message: '未能获取设备 MiOT token，请检查米家会话状态' });
      return;
    }
    res.json({ did: xiaomiDevice.did, scope: xiaomiDevice.scope, token });
  } catch (error) {
    next(error);
  }
};

// ──────────────── 米家空开本地化：同步局域网 Token ────────────────
export const syncXiaomiLocalTokens = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const devices = await xiaomiAdapter.fetchDeviceTokens();
    let updated = 0;
    const skipped: Array<{ did: string; name: string; reason: string }> = [];
    for (const item of devices) {
      if (!item.ip) {
        skipped.push({ did: item.did, name: item.name, reason: '没有局域网 IP' });
        continue;
      }
      const result = await systemService.prismaWrap(async (p) =>
        p.device.updateMany({
          where: { did: item.did },
          data: {
            localip: item.ip,
            controlProtocol: 'miio_lan',
            controlConfig: { miioToken: item.token },
            controlUpdatedAt: new Date(),
          },
        }),
      );
      if (result.count > 0) updated += result.count;
      else skipped.push({ did: item.did, name: item.name, reason: '系统里还没有这台设备（请先同步米家设备）' });
    }
    res.json({ ok: true, total: devices.length, updated, skipped });
  } catch (error: any) {
    res.status(400).json({
      code: 'XIAOMI_LOCAL_TOKEN_SYNC_FAILED',
      message: error?.message || '同步本地 Token 失败',
    });
  }
};
// ──────────────── Camera: capability probing (auto-detect & degrade) ────────────────
export const getCameraCapabilities = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    // 局域网 ONVIF/RTSP 摄像头：使用 ONVIF 能力（PTZ、事件侦测），不走米家云
    const lanConfig = await lanCameraService.getLanCameraConfig(did).catch(() => null);
    if (lanConfig) {
      // 每次打开能力面板时现场探测一次 ONVIF，拿到最新的全部事件能力
      // （厂商 App 里开关的变化/型号差异都能反映出来，而不是用添加设备时的旧结果）
      let caps: any = lanConfig.capabilities ?? {};
      let hasPTZ = !!lanConfig.hasPTZ;
      try {
        const fresh = await probeOnvifDevice({
          ip: lanConfig.ip,
          port: lanConfig.port,
          username: lanConfig.username,
          password: lanConfig.password,
          timeoutMs: 6000,
        });
        if (fresh?.ok) {
          caps = fresh.capabilities ?? caps;
          hasPTZ = !!fresh.hasPTZ;
        }
      } catch {
        /* 探测失败时沿用已保存能力 */
      }
      res.json({
        did,
        controlMode: 'onvif',
        ptz: {
          supported: hasPTZ,
          controllable: hasPTZ,
          calibrate: false,
          directions: hasPTZ ? ['left', 'right', 'up', 'down'] : [],
          zoom: hasPTZ,
          hint: hasPTZ ? undefined : '该摄像头未识别到 ONVIF PTZ 服务',
        },
        nightVision: { supported: false, controllable: false, hint: '夜视设置请使用厂商 App/网页' },
        audio: { supported: !!caps.audio, controllable: false, hint: caps.audio ? '录像含音频，开关请使用厂商 App' : undefined },
        humanDetection: {
          supported: !!caps.human,
          controllable: false,
          hint: caps.human ? '摄像头支持人形侦测事件（开关请在厂商 App 里设置）' : undefined,
        },
        motionDetection: {
          supported: !!caps.motion,
          controllable: false,
          hint: caps.motion ? '摄像头支持移动侦测事件（开关请在厂商 App 里设置）' : undefined,
        },
        lineDetection: {
          supported: !!caps.line,
          controllable: false,
          hint: caps.line ? '摄像头支持越界侦测事件（开关请在厂商 App 里设置）' : undefined,
        },
        intrusionDetection: {
          supported: !!caps.intrusion,
          controllable: false,
          hint: caps.intrusion ? '摄像头支持区域入侵事件（开关请在厂商 App 里设置）' : undefined,
        },
        tamperDetection: {
          supported: !!caps.tamper,
          controllable: false,
          hint: caps.tamper ? '摄像头支持视频遮挡报警（开关请在厂商 App 里设置）' : undefined,
        },
        objectLeftDetection: {
          supported: !!caps.objectLeft,
          controllable: false,
          hint: caps.objectLeft ? '摄像头支持物品遗留检测（开关请在厂商 App 里设置）' : undefined,
        },
        objectRemovedDetection: {
          supported: !!caps.objectRemoved,
          controllable: false,
          hint: caps.objectRemoved ? '摄像头支持物品拿取检测（开关请在厂商 App 里设置）' : undefined,
        },
        smartTracking: {
          supported: !!caps.smartTracking,
          controllable: false,
          hint: caps.smartTracking ? '摄像头支持智能追踪（开关请在厂商 App 里设置）' : undefined,
        },
        faceRecognition: { supported: !!caps.face, controllable: false },
        privacy: { supported: false, controllable: false },
        recording: { supported: true, controllable: true },
        snapshot: { supported: true, controllable: true },
        fetchedAt: Date.now(),
      });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true, name: true } }),
    );
    const xiaomiDevice = resolveXiaomiDeviceRef(device?.model ?? '', did);
    const probe = await xiaomiAdapter.probeCameraCapabilities(
      xiaomiDevice.did,
      device?.model ?? '',
      xiaomiDevice.scope,
    );
    res.json({ did, ...probe });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: generic capability control ────────────────
export const controlCameraCapability = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { capability, value } = (req.body ?? {}) as { capability?: string; value?: unknown };
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    if (!capability) {
      res.status(400).json({ code: 'CAPABILITY_REQUIRED', message: '缺少 capability' });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true } }),
    );
    const xiaomiDevice = resolveXiaomiDeviceRef(device?.model ?? '', did);
    const result = await xiaomiAdapter.controlCameraCapability(
      xiaomiDevice.did,
      device?.model ?? '',
      xiaomiDevice.scope,
      capability,
      value,
    );
    res.json({ did, capability, ...result });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: server-side recording (motion / continuous) ────────────────
export const startCameraRecording = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const { mode, segmentMinutes } = (req.body ?? {}) as { mode?: 'motion' | 'person' | 'continuous'; segmentMinutes?: number };
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true } }),
    );
    const xiaomiDevice = resolveXiaomiDeviceRef(device?.model ?? '', did);
    // 局域网摄像头：开始录像前先确保 go2rtc 桥/摄像头视频流已就绪，
    // 否则刚接入/摄像头刚唤醒时 ffmpeg 无源会立即退出，表现为"点了录像又自动停止"。
    const lanCameraConfig = await lanCameraService.getLanCameraConfig(did).catch(() => null);
    if (lanCameraConfig) {
      await lanCameraService.ensureLanCameraStream(did).catch(() => null);
    }
    // 局域网摄像头：直接使用其 RTSP 源录制，不经过小米云
    const lanSourceUrl = await lanCameraService.resolveLanCameraRtsp(did).catch(() => null);
    if (lanCameraConfig && !lanSourceUrl) {
      res.status(409).json({
        code: 'CAMERA_STREAM_NOT_READY',
        message: '摄像头视频流尚未就绪（可能 WiFi 信号弱或刚唤醒），请先在监控墙打开一次画面或稍后重试',
      });
      return;
    }
    // 录制源优先级（米家摄像头）：① 本地 go2rtc 桥 RTSP（若可用）→ ② 云端 HLS（稳定，ffmpeg 可稳定录制）
    // → ③ 云端 RTSP（兜底，URL 时效短）
    let sourceUrl = lanSourceUrl ?? (await systemService.resolveLocalGo2rtcRtsp(xiaomiDevice.did));
    if (!sourceUrl) {
      try {
        const hls = await xiaomiAdapter.startHLSStreamCached(xiaomiDevice.did, xiaomiDevice.scope);
        if (hls?.hlsUrl) sourceUrl = hls.hlsUrl;
      } catch { /* fallthrough */ }
    }
    if (!sourceUrl) {
      const rtspInfo = await xiaomiAdapter.startRTSPStream(
        xiaomiDevice.did,
        device?.model ?? '',
        xiaomiDevice.scope,
      );
      sourceUrl = rtspInfo.rtspUrl;
    }
    if (mode === 'continuous') {
      const result = await systemService.startContinuousRecording(did, sourceUrl, { segmentMinutes });
      res.json({ did, ...result, mode: 'continuous' });
      return;
    }
    if (mode === 'person') {
      const lanConfig = await lanCameraService.getLanCameraConfig(did).catch(() => null);
      if (!lanConfig || !lanConfig.ip) {
        res.status(400).json({
          code: 'PERSON_RECORDING_LAN_ONLY',
          message: '人形事件触发录像只支持已保存的局域网摄像头（ONVIF）；请先在「添加设备/监控墙」里接入该摄像头',
        });
        return;
      }
      const result = await systemService.startPersonRecording(did, sourceUrl, {
        ip: lanConfig.ip,
        port: lanConfig.port,
        username: lanConfig.username,
        password: lanConfig.password,
      });
      res.json({ did, ...result, mode: 'person' });
      return;
    }
    const result = await systemService.startMotionRecording(did, sourceUrl);
    res.json({ did, ...result, mode: 'motion' });
  } catch (error) {
    next(error);
  }
};

export const stopCameraRecording = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    systemService.stopMotionRecording(did);
    systemService.stopContinuousRecording(did);
    res.json({ did, recording: false });
  } catch (error) {
    next(error);
  }
};

export const getCameraRecordingStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    res.json(systemService.getCameraRecordingState(did));
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: motion detection settings (sensitivity etc.) ────────────────
export const getCameraMotionSettings = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json(systemService.getCameraMotionSettings());
  } catch (error) {
    next(error);
  }
};

export const updateCameraMotionSettings = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { threshold, tailSeconds, ringSeconds } = (req.body ?? {}) as {
      threshold?: number;
      tailSeconds?: number;
      ringSeconds?: number;
    };
    res.json(systemService.updateCameraMotionSettings({ threshold, tailSeconds, ringSeconds }));
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera: recording schedules (auto arm) ────────────────
export const listCameraSchedules = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.query as { did?: string };
    const list = systemService.listCameraSchedules();
    res.json({ schedules: did ? list.filter((s) => s.did === did) : list });
  } catch (error) {
    next(error);
  }
};

export const upsertCameraSchedule = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      id?: string;
      did?: string;
      enabled?: boolean;
      mode?: 'motion' | 'continuous';
      days?: number[];
      start?: string;
      end?: string;
    };
    if (!body.did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const rule = systemService.upsertCameraSchedule({
      id: body.id,
      did: body.did,
      enabled: body.enabled,
      mode: body.mode,
      days: body.days,
      start: body.start,
      end: body.end,
    });
    res.json({ rule });
  } catch (error) {
    next(error);
  }
};

export const deleteCameraSchedule = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ code: 'SCHEDULE_ID_REQUIRED', message: '缺少计划 ID' });
      return;
    }
    res.json(systemService.deleteCameraSchedule(id));
  } catch (error) {
    next(error);
  }
};

export const listCameraRecordings = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    res.json({ did, files: systemService.listMotionRecordings(did) });
  } catch (error) {
    next(error);
  }
};

export const deleteCameraRecording = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did, name } = req.params;
    if (!did || !name) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID 或文件名' });
      return;
    }
    res.json({ did, name, ...systemService.deleteMotionRecording(did, name) });
  } catch (error) {
    next(error);
  }
};

export const listAllCameraRecordings = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json({ files: systemService.listAllCameraRecordings() });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera region: status / auth status query ────────────────
export const xiaomiCameraStatus = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loggedIn = await xiaomiAdapter.isLoggedIn('camera');
    const authStatus = await xiaomiAdapter.getAuthStatus('camera');
    const hasEnvCredentials =
      !!process.env.XIAOMI_CAMERA_USERNAME &&
      !!process.env.XIAOMI_CAMERA_PASSWORD;
    const sessionSnap = await xiaomiAdapter.peekSession('camera');
    res.json({
      loggedIn,
      hasEnvCredentials,
      username:
        authStatus?.username ??
        sessionSnap?.username ??
        (hasEnvCredentials
          ? (process.env.XIAOMI_CAMERA_USERNAME ?? '已配置账号')
          : undefined),
      region: sessionSnap?.region ?? (authStatus as any)?.region ?? null,
      auth: authStatus,
    });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Camera region: device list ────────────────
export const xiaomiCameraDevices = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loggedIn = await xiaomiAdapter.isLoggedIn('camera');
    const authStatus = await xiaomiAdapter.getAuthStatus('camera');
    const sessionSnap = await xiaomiAdapter.peekSession('camera');
    const region = sessionSnap?.region || (authStatus as any)?.region || null;
    const username = sessionSnap?.username || authStatus?.username || undefined;
    console.info('[Ctrl] xiaomiCameraDevices 诊断：', {
      loggedIn,
      sessionRegion: sessionSnap?.region ?? null,
      sessionUserId: sessionSnap?.userId ?? null,
      serviceTokenHead: sessionSnap?.serviceToken
        ? sessionSnap.serviceToken.slice(0, 16) + '...'
        : null,
      authRegion: (authStatus as any)?.region ?? null,
    });
    const devices = loggedIn ? await xiaomiAdapter.fetchCameraDevices() : [];
    // #region debug-point C:camera-scope-devices
    try { const fs=require('fs'); const path=require('path'); let u='http://127.0.0.1:7778/event', s='camera-status-sync'; try { const e=fs.readFileSync(path.resolve(process.cwd(),'..','.dbg','camera-status-sync.env'),'utf8'); u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch { try { const e2=fs.readFileSync(path.resolve(process.cwd(),'.dbg','camera-status-sync.env'),'utf8'); u=e2.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u; s=e2.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s; } catch {} } fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s,runId:'pre-fix',hypothesisId:'C',location:'system.controller.ts:xiaomiCameraDevices',msg:'[DEBUG] camera scope device listing',data:{loggedIn,region,username,authRegion:(authStatus as any)?.region??null,authCode:(authStatus as any)?.code??null,deviceCount:devices.length,firstDid:devices[0]?.did??null,firstOnline:devices[0]?.online??null}})}).catch(()=>{}); } catch {}
    // #endregion
    res.json({
      loggedIn,
      region,
      username,
      auth: authStatus,
      devices,
    });
  } catch (error) {
    next(error);
  }
};

// ──────────────── Local device adapter: read config ────────────────
export const getDeviceAdapterConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const did = String(req.params.did ?? '').trim();
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const cfg = await systemService.getDeviceAdapterConfig(did);
    const out: any = { ...cfg };
    if (out.password) out.password = '***REDACTED***';
    res.json(out);
  } catch (error) {
    next(error);
  }
};

// ──────────────── Local device adapter: write config ────────────────
export const saveDeviceAdapterConfig = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const did = String(req.params.did ?? '').trim();
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const body = (req.body ?? {}) as any;
    const operatorUserId = (req.user as any)?.id ?? null;
    const result = await systemService.saveDeviceAdapterConfig(
      did,
      {
        kind: body.kind ?? undefined,
        baseUrl: body.baseUrl ?? undefined,
        username: body.username ?? undefined,
        password: body.password ?? undefined,
      },
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

// ──────────────── Local device adapter: refresh runtime ────────────────
export const refreshDeviceRuntime = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const did = String(req.params.did ?? '').trim();
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    const operatorUserId = (req.user as any)?.id ?? null;
    const result = await systemService.refreshDeviceRuntime(
      did,
      operatorUserId,
      getOperationActorContextFromRequest(req),
    );
    if (!result.ok) {
      res.json({
        ok: false,
        kind: result.kind,
        errorMessage:
          result.errorMessage ||
          '本地适配器访问失败，请确认 WebUI IP/账号密码正确，或设备在局域网可达',
        runtime: null,
      });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
};
