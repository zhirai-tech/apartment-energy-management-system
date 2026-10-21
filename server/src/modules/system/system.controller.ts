import { Request, Response, NextFunction } from 'express';
import { SystemSettingsData } from '@shared/index';
import { systemService } from './system.service';
import { xiaomiAdapter } from './xiaomi.adapter';
import { XIAOMI_USERNAME, XIAOMI_PASSWORD } from '../../config/env';
import { getOperationActorContextFromRequest } from '../../lib/request-context';
import { scanLanDevices } from '../../lib/lan-scan';

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
    // ① Call MiOT start_rtsp_stream to obtain the LAN RTSP address + token
    const rtspInfo = await xiaomiAdapter.startRTSPStream(did, model, 'camera');
    // ② Let the media layer (ffmpeg / MediaMTX) convert to browser-playable HLS + WebRTC
    const streamUrls = await systemService.ensureCameraStreamProxy(did, rtspInfo.rtspUrl, {
      model,
      name,
    });
    res.json({
      did,
      model,
      streamAddress: rtspInfo.streamAddress,
      streamAuthToken: rtspInfo.streamAuthToken ? '***REDACTED***' : '',
      rtspUrl: rtspInfo.streamAddress,
      ...streamUrls,
    });
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
      direction?: 'left' | 'right' | 'up' | 'down' | 'stop';
      speed?: number;
    };
    if (!did) {
      res.status(400).json({ code: 'DID_REQUIRED', message: '缺少设备 DID' });
      return;
    }
    if (!direction || !['left', 'right', 'up', 'down', 'stop'].includes(direction)) {
      res.status(400).json({
        code: 'INVALID_DIRECTION',
        message: 'direction 必须是 left / right / up / down / stop',
      });
      return;
    }
    const device = await systemService.prismaWrap(async (p) =>
      p.device.findUnique({ where: { did }, select: { model: true } }),
    );
    const ok = await xiaomiAdapter.moveCameraPTZ(
      did,
      direction,
      typeof speed === 'number' ? speed : 50,
      device?.model ?? '',
      'camera',
    );
    res.json({ ok: !!ok, did, direction, speed: typeof speed === 'number' ? speed : 50 });
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
