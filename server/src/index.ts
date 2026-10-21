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
import authRoutes from './modules/auth/auth.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import energyRoutes from './modules/energy/energy.routes';
import systemRoutes from './modules/system/system.routes';
import logsRoutes from './modules/logs/logs.routes';

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

setupSwagger(app);

app.use(notFound);
app.use(errorHandler);

const httpServer = http.createServer(app);

initSocketIO(httpServer);

httpServer.listen(env.PORT, async () => {
  try {
    await applyAdminResetFromEnv();
    await startCronJobs();
    console.log(`listening on ${env.PORT}`);
  } catch {
  }
});
