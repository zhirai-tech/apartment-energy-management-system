import { Request, Response, NextFunction } from 'express';
import { lanCameraService, markLanCameraOnline } from './lan-camera.service';
import { getOperationActorContextFromRequest } from '../../lib/request-context';
import { readCameraFeatures, writeCameraFeatures } from './lib/mercury-camera';
import { controlOnvifPtz, getOnvifPtzPresets } from './lib/onvif';
import { getTplinkDetectionState, setTplinkDetectionEnabled } from './lib/tplink-vigi';

/** 摄像头列表（局域网 + 米家云），监控墙使用 */
export const listCameras = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await lanCameraService.listCameras();
    res.json(result);
  } catch (error) {
    next(error);
  }
};

/** ONVIF 局域网发现 */
export const discoverLanCameras = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await lanCameraService.discoverCameras();
    res.json(result);
  } catch (error) {
    next(error);
  }
};

/** 探测摄像头（ONVIF / RTSP），不落库 */
export const probeLanCamera = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      ip?: string;
      port?: number;
      username?: string;
      password?: string;
      brand?: string | null;
      rtspUrl?: string | null;
    };
    if (!body.ip) {
      res.status(400).json({ code: 'IP_REQUIRED', message: '请填写摄像头 IP 地址' });
      return;
    }
    const result = await lanCameraService.probeCamera({
      ip: body.ip,
      port: body.port,
      username: body.username,
      password: body.password,
      brand: body.brand ?? null,
      rtspUrl: body.rtspUrl ?? null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

/** 新增局域网摄像头 */
export const createLanCamera = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await lanCameraService.saveLanCamera(
      {
        name: typeof body.name === 'string' ? body.name : undefined,
        ip: String(body.ip ?? ''),
        port: typeof body.port === 'number' ? body.port : Number(body.port) || undefined,
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
        brand: typeof body.brand === 'string' ? body.brand : null,
        model: typeof body.model === 'string' ? body.model : null,
        source: body.source === 'rtsp' ? 'rtsp' : 'onvif',
        rtspUrl: String(body.rtspUrl ?? ''),
        subRtspUrl: typeof body.subRtspUrl === 'string' ? body.subRtspUrl : null,
        snapshotUrl: typeof body.snapshotUrl === 'string' ? body.snapshotUrl : null,
        hasPTZ: body.hasPTZ === true,
        transcodeH264: body.transcodeH264 === true,
        preferSubStream: body.preferSubStream !== false,
        capabilities: body.capabilities && typeof body.capabilities === 'object' ? (body.capabilities as any) : null,
        roomId: typeof body.roomId === 'string' ? body.roomId : body.roomId === null ? null : undefined,
      },
      req.user?.id ?? null,
      getOperationActorContextFromRequest(req),
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

/** 更新局域网摄像头 */
export const updateLanCamera = async (
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await lanCameraService.saveLanCamera(
      {
        did,
        name: typeof body.name === 'string' ? body.name : undefined,
        ip: String(body.ip ?? ''),
        port: typeof body.port === 'number' ? body.port : Number(body.port) || undefined,
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
        brand: typeof body.brand === 'string' ? body.brand : null,
        model: typeof body.model === 'string' ? body.model : null,
        source: body.source === 'rtsp' ? 'rtsp' : 'onvif',
        rtspUrl: String(body.rtspUrl ?? ''),
        subRtspUrl: typeof body.subRtspUrl === 'string' ? body.subRtspUrl : null,
        snapshotUrl: typeof body.snapshotUrl === 'string' ? body.snapshotUrl : null,
        hasPTZ: body.hasPTZ === true,
        transcodeH264: body.transcodeH264 === true,
        preferSubStream: body.preferSubStream !== false,
        capabilities: body.capabilities && typeof body.capabilities === 'object' ? (body.capabilities as any) : null,
        roomId: typeof body.roomId === 'string' ? body.roomId : body.roomId === null ? null : undefined,
      },
      req.user?.id ?? null,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

/** 删除局域网摄像头 */
export const deleteLanCamera = async (
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
    const result = await lanCameraService.deleteLanCamera(
      did,
      req.user?.id ?? null,
      getOperationActorContextFromRequest(req),
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
};

/** 读取局域网摄像头配置（编辑表单回填用，仅管理员） */
export const getLanCameraConfigDetail = async (
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
    const config = await lanCameraService.getLanCameraConfig(did);
    if (!config) {
      res.status(404).json({ code: 'LAN_CAMERA_NOT_FOUND', message: '该设备不是已配置的局域网摄像头' });
      return;
    }
    res.json({ did, config });
  } catch (error) {
    next(error);
  }
};

/** 测试已保存的局域网摄像头（RTSP 直连 + HLS 状态） */
export const testLanCamera = async (
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
    const result = await lanCameraService.testLanCamera(did);
    res.json(result);
  } catch (error) {
    next(error);
  }
};
/** 读取摄像头厂商侧功能开关（移动侦测 / 人形侦测 / 录音 / 事件录像） */
export const getLanCameraFeatures = async (
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
    try {
      const config = await lanCameraService.getLanCameraConfig(did);
      // 仅水星/MERCURY 同源协议支持系统内的厂商侧开关；其他品牌只走 ONVIF（云台/事件/录像）
      if (config && !/mercury|水星/i.test(String(config.brand ?? ''))) {
        res.json({
          did,
          supported: false,
          vendor: config.brand || 'unknown',
          message: `该摄像头（${config.brand || '未知品牌'}）不支持系统内的厂商侧开关，请在厂家 App 中设置；系统内可用：ONVIF 云台、直播、事件触发录像。`,
        });
        return;
      }
      const features = await readCameraFeatures(did);
      res.json({ did, ...features });
    } catch (featureError: any) {
      // 不支持或暂时连不上时返回 supported=false，让前端显示"该功能暂不支持/不可用"，而不是 500
      res.json({
        did,
        supported: false,
        vendor: 'unknown',
        message: featureError?.message || '该摄像头不支持厂商功能接口',
      });
    }
  } catch (error) {
    next(error);
  }
};

/** 写入摄像头厂商侧功能开关 */
export const updateLanCameraFeatures = async (
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
    const body = (req.body ?? {}) as {
      motionDetected?: boolean;
      humanDetected?: boolean;
      sensitivity?: 'low' | 'medium' | 'high';
      eventRecording?: boolean;
      audioEnabled?: boolean;
    };
    const features = await writeCameraFeatures(did, body);
    res.json({ did, ...features });
  } catch (error: any) {
    res.status(400).json({
      code: 'CAMERA_FEATURE_UPDATE_FAILED',
      message: error?.message || '摄像头功能设置失败',
    });
  }
};

/** 局域网摄像头 PTZ 云台控制（ONVIF）：方向移动 / 停止 / 回中 / 预置位 */
export const controlLanCameraPtz = async (
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
    const config = await lanCameraService.getLanCameraConfig(did);
    if (!config) {
      res.status(404).json({ code: 'LAN_CAMERA_NOT_FOUND', message: '该设备不是已配置的局域网摄像头' });
      return;
    }
    const body = (req.body ?? {}) as {
      action?: string;
      speed?: number;
      presetToken?: string;
      durationMs?: number;
    };
    const action = String(body.action ?? '').trim();
    const allowed = ['left', 'right', 'up', 'down', 'zoomIn', 'zoomOut', 'stop', 'home', 'gotoPreset'];
    if (!allowed.includes(action)) {
      res.status(400).json({
        code: 'PTZ_ACTION_INVALID',
        message: `不支持的云台动作：${action || '(空)'}`,
      });
      return;
    }
    const ptzInput = {
      ip: config.ip,
      port: config.port || 80,
      username: config.username,
      password: config.password,
      action: action as any,
      speed: Number(body.speed) || 50,
      presetToken: body.presetToken,
    };
    const result = await controlOnvifPtz(ptzInput);
    if (result.ok) {
      void markLanCameraOnline(did);
    }
    // 方向移动：服务端定时自动停止，避免一直转到极限
    const durationMs = Math.max(200, Math.min(3000, Number(body.durationMs) || 600));
    if (result.ok && ['left', 'right', 'up', 'down', 'zoomIn', 'zoomOut'].includes(action)) {
      setTimeout(() => {
        controlOnvifPtz({ ...ptzInput, action: 'stop' }).catch(() => {});
      }, durationMs);
    }
    res.json({ did, ...result });
  } catch (error: any) {
    next(error);
  }
};

/** 读取局域网摄像头 ONVIF 预置位列表 */
export const getLanCameraPtzPresets = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const did = String(req.params.did ?? '').trim();
    const config = await lanCameraService.getLanCameraConfig(did);
    if (!config) {
      res.status(404).json({ code: 'LAN_CAMERA_NOT_FOUND', message: '该设备不是已配置的局域网摄像头' });
      return;
    }
    const result = await getOnvifPtzPresets({
      ip: config.ip,
      port: config.port || 80,
      username: config.username,
      password: config.password,
    });
    res.json({ did, ...result });
  } catch (error: any) {
    next(error);
  }
};/** TP-Link 摄像头侦测开关状态（人形侦测 / 区域入侵），可直接在系统里开关 */
export const getLanCameraDetections = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const config = await lanCameraService.getLanCameraConfig(did);
    if (!config) {
      res.status(404).json({ code: 'CAMERA_NOT_FOUND', message: '摄像头不存在' });
      return;
    }
    if (!/tp-?link/i.test(String(config.brand ?? ''))) {
      res.json({ did, supported: false, message: '该品牌暂不支持系统内侦测开关' });
      return;
    }
    const state = await getTplinkDetectionState({
      ip: config.ip,
      port: config.port,
      username: config.username,
      password: config.password,
    });
    res.json({ did, supported: true, ...state });
  } catch (error) {
    next(error);
  }
};

/** 开关 TP-Link 摄像头侦测（人形侦测 / 区域入侵） */
export const setLanCameraDetection = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { did } = req.params;
    const { feature, enabled } = (req.body ?? {}) as { feature?: string; enabled?: boolean };
    if (feature !== 'human' && feature !== 'intrusion') {
      res.status(400).json({ code: 'FEATURE_INVALID', message: '仅支持 human / intrusion' });
      return;
    }
    const config = await lanCameraService.getLanCameraConfig(did);
    if (!config) {
      res.status(404).json({ code: 'CAMERA_NOT_FOUND', message: '摄像头不存在' });
      return;
    }
    if (!/tp-?link/i.test(String(config.brand ?? ''))) {
      res.status(400).json({ code: 'BRAND_UNSUPPORTED', message: '该品牌暂不支持系统内侦测开关' });
      return;
    }
    await setTplinkDetectionEnabled(
      { ip: config.ip, port: config.port, username: config.username, password: config.password },
      feature,
      enabled === true,
    );
    const state = await getTplinkDetectionState({
      ip: config.ip,
      port: config.port,
      username: config.username,
      password: config.password,
    });
    res.json({ did, supported: true, ...state });
  } catch (error) {
    next(error);
  }
};