import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  getSettings,
  getSites,
  createSite,
  updateSite,
  updateSettings,
  refreshReferencePrice,
  xiaomiStatus,
  xiaomiDevices,
  xiaomiLogin,
  xiaomiSync,
  controlDevice,
  renameDevice,
  updateRoomAnnotation,
  updateRoomFloor,
  bulkControlDevices,
  lanScan,
  persistLanDevices,
  getDeviceSnapshot,
  updateDeviceCamera,
  xiaomiCameraLogin,
  xiaomiCameraSendEmailCode,
  xiaomiCameraVerifyEmailCode,
  xiaomiCameraDevices,
  xiaomiCameraStatus,
  getCameraStream,
  controlCameraPTZ,
  getDeviceAdapterConfig,
  saveDeviceAdapterConfig,
  refreshDeviceRuntime,
} from './system.controller';

const router = Router();

router.get('/settings', authenticate, getSettings);
router.get('/sites', authenticate, getSites);
router.post('/sites', authenticate, requireRole(UserRole.admin), createSite);
router.put('/sites/:siteId', authenticate, requireRole(UserRole.admin), updateSite);
router.put('/settings', authenticate, requireRole(UserRole.admin, UserRole.boss), updateSettings);
router.post('/settings/price-reference/refresh', authenticate, requireRole(UserRole.admin, UserRole.boss), refreshReferencePrice);
router.post('/lan-scan', authenticate, requireRole(UserRole.admin, UserRole.boss), lanScan);
router.post('/lan-device/persist', authenticate, requireRole(UserRole.admin, UserRole.boss), persistLanDevices);
router.get('/device/:did/snapshot', authenticate, getDeviceSnapshot);
router.put('/device/:did/camera', authenticate, requireRole(UserRole.admin, UserRole.boss), updateDeviceCamera);
// ─── Local device adapter: 5G CPE / Nokia Mesh Beacon ───
router.get('/device/:did/adapter_config', authenticate, getDeviceAdapterConfig);
router.put('/device/:did/adapter_config', authenticate, requireRole(UserRole.admin, UserRole.boss), saveDeviceAdapterConfig);
router.get('/device/:did/refresh_runtime', authenticate, requireRole(UserRole.admin, UserRole.boss), refreshDeviceRuntime);
router.get('/xiaomi/status', authenticate, xiaomiStatus);
router.get('/xiaomi/devices', authenticate, xiaomiDevices);
router.post('/xiaomi/login', authenticate, requireRole(UserRole.admin), xiaomiLogin);
router.post('/xiaomi/login/continue', authenticate, requireRole(UserRole.admin), xiaomiLogin);
router.post('/xiaomi/sync', authenticate, requireRole(UserRole.admin), xiaomiSync);
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
router.post('/devices/control-all', authenticate, requireRole(UserRole.admin, UserRole.boss), bulkControlDevices);
router.post('/device/:did/control', authenticate, requireRole(UserRole.admin, UserRole.boss), controlDevice);
router.put('/device/:did/name', authenticate, requireRole(UserRole.admin, UserRole.boss), renameDevice);
router.put('/room/:roomId/annotation', authenticate, requireRole(UserRole.admin, UserRole.boss), updateRoomAnnotation);
router.put('/room/:roomId/floor', authenticate, requireRole(UserRole.admin, UserRole.boss), updateRoomFloor);

export default router;
