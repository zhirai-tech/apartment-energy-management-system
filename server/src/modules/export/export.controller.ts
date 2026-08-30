import { Request, Response, NextFunction } from 'express';
import {
  generateEnergySummaryCsv,
  generateEnergyDailyCsv,
  generateEnergyWeeklyCsv,
  generateOperationsCsv,
} from './export.service';

function sendCsv(res: Response, filename: string, content: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(content);
}

export const exportEnergySummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const siteId = typeof req.query.siteId === 'string' && req.query.siteId ? req.query.siteId : undefined;
    const csv = await generateEnergySummaryCsv(siteId);
    sendCsv(res, `zhirai-用电汇总-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (error) {
    next(error);
  }
};

export const exportEnergyDaily = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const siteId = typeof req.query.siteId === 'string' && req.query.siteId ? req.query.siteId : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
    const csv = await generateEnergyDailyCsv({ siteId, from, to });
    sendCsv(res, `zhirai-逐日用电-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (error) {
    next(error);
  }
};

export const exportEnergyWeekly = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const siteId = typeof req.query.siteId === 'string' && req.query.siteId ? req.query.siteId : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
    const csv = await generateEnergyWeeklyCsv({ siteId, from, to });
    sendCsv(res, `zhirai-每周用电-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (error) {
    next(error);
  }
};

export const exportOperations = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const siteId = typeof req.query.siteId === 'string' && req.query.siteId ? req.query.siteId : undefined;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
    const csv = await generateOperationsCsv({ siteId, from, to, category });
    sendCsv(res, `zhirai-操作记录-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (error) {
    next(error);
  }
};
