import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  exportEnergySummary,
  exportEnergyDaily,
  exportEnergyWeekly,
  exportOperations,
} from './export.controller';

const router = Router();

router.get('/energy-summary', authenticate, requireRole(UserRole.admin, UserRole.boss), exportEnergySummary);
router.get('/energy-daily', authenticate, requireRole(UserRole.admin, UserRole.boss), exportEnergyDaily);
router.get('/energy-weekly', authenticate, requireRole(UserRole.admin, UserRole.boss), exportEnergyWeekly);
router.get('/operations', authenticate, requireRole(UserRole.admin, UserRole.boss), exportOperations);

export default router;
