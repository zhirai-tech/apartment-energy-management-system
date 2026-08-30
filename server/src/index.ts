import 'dotenv/config';
import express from 'express';
import cors, { type CorsOptions } from 'cors';
import http from 'http';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import env from './config/env';
import { errorHandler, notFound } from './lib/errors';
import { initSocketIO } from './lib/socket';
import { setupSwagger } from './lib/swagger';
import { startCronJobs } from './lib/cron';
import { applyAdminResetFromEnv } from './modules/auth/auth.service';
import { systemService } from './modules/system/system.service';
import authRoutes from './modules/auth/auth.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import energyRoutes from './modules/energy/energy.routes';
import systemRoutes from './modules/system/system.routes';
import logsRoutes from './modules/logs/logs.routes';
import exportRoutes from './modules/export/export.routes';

const app = express();
app.set('trust proxy', 1);

const corsOptions: CorsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  optionsSuccessStatus: 204,
};

app.use(express.json());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 临时：摄像头/流相关请求日志，用于排查“画面不出现/代理不触发”问题
app.use((req, _res, next) => {
  if (/camera_stream|camera_record|camera_capabilities|camera_control|snapshot|streams\/hls|\.m3u8|\.ts$/i.test(req.path)) {
    console.log(`[HTTP] ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.originalUrl}`);
  }
  next();
});

const STREAM_ROOT = path.resolve(process.cwd(), 'streams');
try {
  if (!fs.existsSync(STREAM_ROOT)) fs.mkdirSync(STREAM_ROOT, { recursive: true });
  const hlsRoot = path.join(STREAM_ROOT, 'hls');
  if (!fs.existsSync(hlsRoot)) fs.mkdirSync(hlsRoot, { recursive: true });
} catch {
  /* noop */
}
app.use('/streams', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(STREAM_ROOT, {
  maxAge: 0,
  etag: false,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  },
}));

const RECORDING_ROOT = path.resolve(process.cwd(), 'recordings');
try {
  if (!fs.existsSync(RECORDING_ROOT)) fs.mkdirSync(RECORDING_ROOT, { recursive: true });
} catch {
  /* noop */
}
app.use('/recordings', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
}, express.static(RECORDING_ROOT, {
  maxAge: 0,
  etag: false,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  },
}));

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/energy', energyRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/export', exportRoutes);

setupSwagger(app);

// 原生部署模式：可选由后端直接托管前端构建产物（设置 CLIENT_DIST_DIR 指向 client/dist）。
const clientDistDir = process.env.CLIENT_DIST_DIR
  ? path.resolve(process.cwd(), process.env.CLIENT_DIST_DIR)
  : null;
if (clientDistDir && fs.existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  app.get(/^\/(?!api\/|streams\/|recordings\/|socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

const httpServer = http.createServer(app);

// 关键：调大 keep-alive 超时，避免浏览器复用已在 5s 默认超时后被服务端关闭的
// 长连接而触发 net::ERR_ABORTED / ECONNRESET（前端轮询 + 页面刷新场景多发）。
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;

initSocketIO(httpServer);

httpServer.listen(env.PORT, async () => {
  try {
    await applyAdminResetFromEnv();
    await startCronJobs();
    // 摄像头录制计划（自动布防）引擎
    systemService.startScheduleEngine();
    console.log(`listening on ${env.PORT}`);
  } catch {
  }
});
