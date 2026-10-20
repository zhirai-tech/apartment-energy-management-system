import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  getSettings,
  getRemoteAccessInfo,
  renewRemoteAccess,
  getSites,
  createSite,
  updateSite,
  updateSettings,
  refreshReferencePrice,
  xiaomiStatus,
  xiaomiDevices,
  xiaomiLogin,
  xiaomiSync,
  syncXiaomiLocalTokens,
  controlDevice,
  renameDevice,
  updateRoomAnnotation,
  updateRoomFloor,
  bulkControlDevices,
  lanScan,
  listLanScanHistory,
  clearLanScanHistory,
  detectLanSubnet,
  persistLanDevices,
  lanDeviceProbe,
  manualAddDevice,
  getDeviceSnapshot,
  updateDeviceCamera,
  updateDeviceCategory,
  deleteDevice,
  xiaomiCameraLogin,
  xiaomiCameraSendEmailCode,
  xiaomiCameraVerifyEmailCode,
  xiaomiCameraDevices,
  xiaomiCameraStatus,
  getCameraStream,
  controlCameraPTZ,
  getCameraCapabilities,
  controlCameraCapability,
  getCameraMiotToken,
  startCameraRecording,
  stopCameraRecording,
  getCameraRecordingStatus,
  getCameraMotionSettings,
  updateCameraMotionSettings,
  listCameraSchedules,
  upsertCameraSchedule,
  deleteCameraSchedule,
  listCameraRecordings,
  deleteCameraRecording,
  listAllCameraRecordings,
  getDeviceAdapterConfig,
  saveDeviceAdapterConfig,
  refreshDeviceRuntime,
  getDeviceControlConfig,
  updateDeviceControlConfig,
  testDeviceControlConfig,
} from './system.controller';
import {
  listCameras,
  discoverLanCameras,
  probeLanCamera,
  createLanCamera,
  updateLanCamera,
  deleteLanCamera,
  testLanCamera,
  getLanCameraConfigDetail,
  getLanCameraFeatures,
  updateLanCameraFeatures,
  controlLanCameraPtz,
  getLanCameraPtzPresets,
  getLanCameraDetections,
  setLanCameraDetection,
} from './lan-camera.controller';

const router = Router();

// ─── 统一摄像头管理（局域网 ONVIF/RTSP + 米家云） ───
router.get('/cameras', authenticate, listCameras);
router.post('/cameras/discover', authenticate, requireRole(UserRole.admin, UserRole.boss), discoverLanCameras);
router.post('/cameras/probe', authenticate, requireRole(UserRole.admin, UserRole.boss), probeLanCamera);
router.post('/cameras/lan', authenticate, requireRole(UserRole.admin, UserRole.boss), createLanCamera);
router.put('/cameras/lan/:did', authenticate, requireRole(UserRole.admin, UserRole.boss), updateLanCamera);
router.get('/cameras/lan/:did/config', authenticate, requireRole(UserRole.admin, UserRole.boss), getLanCameraConfigDetail);
router.get('/cameras/lan/:did/features', authenticate, getLanCameraFeatures);
router.put('/cameras/lan/:did/features', authenticate, requireRole(UserRole.admin, UserRole.boss), updateLanCameraFeatures);
router.post('/cameras/lan/:did/test', authenticate, requireRole(UserRole.admin, UserRole.boss), testLanCamera);
router.post('/cameras/lan/:did/ptz', authenticate, requireRole(UserRole.admin, UserRole.boss), controlLanCameraPtz);
router.get('/cameras/lan/:did/ptz/presets', authenticate, getLanCameraPtzPresets);
router.get('/cameras/lan/:did/detections', authenticate, getLanCameraDetections);
router.post('/cameras/lan/:did/detections', authenticate, requireRole(UserRole.admin, UserRole.boss), setLanCameraDetection);
router.delete('/cameras/lan/:did', authenticate, requireRole(UserRole.admin, UserRole.boss), deleteLanCamera);

router.get('/settings', authenticate, getSettings);
router.get('/sites', authenticate, getSites);
router.post('/sites', authenticate, requireRole(UserRole.admin), createSite);
router.put('/sites/:siteId', authenticate, requireRole(UserRole.admin), updateSite);
router.put('/settings', authenticate, requireRole(UserRole.admin, UserRole.boss), updateSettings);
router.post('/settings/price-reference/refresh', authenticate, requireRole(UserRole.admin, UserRole.boss), refreshReferencePrice);
router.post('/lan-scan', authenticate, requireRole(UserRole.admin, UserRole.boss), lanScan);
router.get('/lan-scans', authenticate, listLanScanHistory);
router.delete('/lan-scans', authenticate, requireRole(UserRole.admin, UserRole.boss), clearLanScanHistory);
router.get('/lan-scan/subnets', authenticate, detectLanSubnet);
// ─── 远程访问（外网 cloudflared 隧道地址） ───
router.get('/remote-access', authenticate, getRemoteAccessInfo);
router.post('/remote-access/renew', authenticate, requireRole(UserRole.admin, UserRole.boss), renewRemoteAccess);
router.post('/lan-scan/probe', authenticate, requireRole(UserRole.admin, UserRole.boss), lanDeviceProbe);
router.post('/lan-device/persist', authenticate, requireRole(UserRole.admin, UserRole.boss), persistLanDevices);
router.post('/device/manual', authenticate, requireRole(UserRole.admin, UserRole.boss), manualAddDevice);
router.get('/device/:did/snapshot', authenticate, getDeviceSnapshot);
router.put('/device/:did/camera', authenticate, requireRole(UserRole.admin, UserRole.boss), updateDeviceCamera);
router.put('/device/:did/category', authenticate, requireRole(UserRole.admin, UserRole.boss), updateDeviceCategory);
router.delete('/device/:did', authenticate, requireRole(UserRole.admin, UserRole.boss), deleteDevice);
// ─── Local device adapter: 5G CPE / Nokia Mesh Beacon ───
router.get('/device/:did/adapter_config', authenticate, getDeviceAdapterConfig);
router.put('/device/:did/adapter_config', authenticate, requireRole(UserRole.admin, UserRole.boss), saveDeviceAdapterConfig);
router.get('/device/:did/refresh_runtime', authenticate, requireRole(UserRole.admin, UserRole.boss), refreshDeviceRuntime);
// ─── Generic local-LAN device control (HTTP / Modbus TCP / Tuya / MiIO) ───
router.get('/device/:did/control-config', authenticate, getDeviceControlConfig);
router.put('/device/:did/control-config', authenticate, requireRole(UserRole.admin, UserRole.boss), updateDeviceControlConfig);
router.post('/device/:did/control-config/test', authenticate, requireRole(UserRole.admin, UserRole.boss), testDeviceControlConfig);
router.get('/xiaomi/status', authenticate, xiaomiStatus);
router.get('/xiaomi/devices', authenticate, xiaomiDevices);
router.post('/xiaomi/login', authenticate, requireRole(UserRole.admin), xiaomiLogin);
router.post('/xiaomi/login/continue', authenticate, requireRole(UserRole.admin), xiaomiLogin);
router.post('/xiaomi/sync', authenticate, requireRole(UserRole.admin), xiaomiSync);
router.post('/xiaomi/local/sync-breakers', authenticate, requireRole(UserRole.admin, UserRole.boss), syncXiaomiLocalTokens);
// ─── MiOT dual session: camera region (independent EU account) ───
router.get('/xiaomi/camera/status', authenticate, requireRole(UserRole.admin), xiaomiCameraStatus);
router.post('/xiaomi/camera/login', authenticate, requireRole(UserRole.admin), xiaomiCameraLogin);
router.post('/xiaomi/camera/login/continue', authenticate, requireRole(UserRole.admin), xiaomiCameraLogin);
router.post('/xiaomi/camera/send_email_code', authenticate, requireRole(UserRole.admin), xiaomiCameraSendEmailCode);
router.post('/xiaomi/camera/verify_email_code', authenticate, requireRole(UserRole.admin), xiaomiCameraVerifyEmailCode);
router.get('/xiaomi/camera/devices', authenticate, xiaomiCameraDevices);
// ─── MiOT camera video stream + PTZ control ───
router.get('/device/:did/camera_stream', authenticate, getCameraStream);
router.post('/device/:did/camera_ptz', authenticate, requireRole(UserRole.admin, UserRole.boss), controlCameraPTZ);
// ─── Camera capability auto-detect + generic control ───
router.get('/device/:did/camera_capabilities', authenticate, getCameraCapabilities);
router.post('/device/:did/camera_control', authenticate, requireRole(UserRole.admin, UserRole.boss), controlCameraCapability);
// ─── Camera MiOT token (go2rtc local pull) ───
router.get('/device/:did/camera_token', authenticate, requireRole(UserRole.admin, UserRole.boss), getCameraMiotToken);
// ─── Camera recording (motion / continuous / schedules) ───
router.post('/device/:did/camera_record/start', authenticate, requireRole(UserRole.admin, UserRole.boss), startCameraRecording);
router.post('/device/:did/camera_record/stop', authenticate, requireRole(UserRole.admin, UserRole.boss), stopCameraRecording);
router.get('/device/:did/camera_record/status', authenticate, getCameraRecordingStatus);
router.get('/device/:did/camera_record/list', authenticate, listCameraRecordings);
router.delete('/device/:did/camera_record/:name', authenticate, requireRole(UserRole.admin, UserRole.boss), deleteCameraRecording);
router.get('/camera/recordings', authenticate, listAllCameraRecordings);
router.get('/camera/motion-settings', authenticate, requireRole(UserRole.admin, UserRole.boss), getCameraMotionSettings);
router.put('/camera/motion-settings', authenticate, requireRole(UserRole.admin, UserRole.boss), updateCameraMotionSettings);
router.get('/camera/schedules', authenticate, requireRole(UserRole.admin, UserRole.boss), listCameraSchedules);
router.post('/camera/schedules', authenticate, requireRole(UserRole.admin, UserRole.boss), upsertCameraSchedule);
router.delete('/camera/schedules/:id', authenticate, requireRole(UserRole.admin, UserRole.boss), deleteCameraSchedule);
router.post('/devices/control-all', authenticate, requireRole(UserRole.admin, UserRole.boss), bulkControlDevices);
router.post('/device/:did/control', authenticate, requireRole(UserRole.admin, UserRole.boss), controlDevice);
router.put('/device/:did/name', authenticate, requireRole(UserRole.admin, UserRole.boss), renameDevice);
router.put('/room/:roomId/annotation', authenticate, requireRole(UserRole.admin, UserRole.boss), updateRoomAnnotation);
router.put('/room/:roomId/floor', authenticate, requireRole(UserRole.admin, UserRole.boss), updateRoomFloor);

export default router;
