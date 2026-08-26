import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const RELEASE = path.join(ROOT, 'release');

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

function cpDir(src, dest, excludeBaseNames = []) {
  if (!fs.existsSync(src)) return;
  mkdir(dest);
  const exclude = new Set(excludeBaseNames);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => !exclude.has(path.basename(s)),
  });
}

function cpFile(src, dest) {
  if (!fs.existsSync(src)) return;
  mkdir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function write(dest, content) {
  mkdir(path.dirname(dest));
  fs.writeFileSync(dest, content, 'utf8');
}

// go2rtc 摄像头桥配置模板（脱敏，不含真实令牌/账号/IP）
const go2rtcTemplate = `# go2rtc 摄像头桥配置（模板）
# 安全提示：请勿在此提交真实的小米令牌/账号密码/摄像头IP。
# 部署时按需填写你的摄像头接入信息，然后重启 go2rtc。

streams:
  # 小米摄像头示例（把 <账号> <密码> <摄像头IP> <设备ID> <型号> 替换为真实值）：
  #   <设备ID>: xiaomi://<账号>:<密码>@<摄像头IP>?did=<设备ID>&model=<型号>
`;

// ---------- 清理 ----------
rm(RELEASE);
mkdir(RELEASE);

// =====================================================================
// 1) 容器镜像包（docker compose 一键部署，跨平台）
// =====================================================================
const C = path.join(RELEASE, 'zaem-container');
mkdir(C);
cpDir(path.join(ROOT, 'server'), path.join(C, 'server'), ['node_modules', 'dist', 'streams', 'recordings', '.env', 'generated']);
cpDir(path.join(ROOT, 'client'), path.join(C, 'client'), ['node_modules', 'dist']);
cpDir(path.join(ROOT, 'shared'), path.join(C, 'shared'));
write(path.join(C, 'go2rtc', 'go2rtc.yaml'), go2rtcTemplate);
cpFile(path.join(ROOT, 'docker-compose.yml'), path.join(C, 'docker-compose.yml'));
cpFile(path.join(ROOT, '.dockerignore'), path.join(C, '.dockerignore'));

write(path.join(C, '.env.example'), `# 复制为 .env 后按需修改（docker compose 会自动读取同目录 .env）
JWT_SECRET=请改成一段足够长的随机字符串
CORS_ORIGIN=http://localhost:3010
XIAOMI_USERNAME=
XIAOMI_PASSWORD=
`);

write(path.join(C, 'start.sh'), `#!/bin/sh
set -e
cd "$(dirname "$0")"
docker compose up -d --build
echo "ZHIRAI 已启动：Web UI -> http://<本机IP>:3010"
`);

write(path.join(C, 'start.ps1'), `Set-Location $PSScriptRoot
docker compose up -d --build
Write-Host "ZHIRAI 已启动：Web UI -> http://<本机IP>:3010"
`);

write(path.join(C, 'stop.sh'), `#!/bin/sh
set -e
cd "$(dirname "$0")"
docker compose down
`);

write(path.join(C, 'stop.ps1'), `Set-Location $PSScriptRoot
docker compose down
`);

// =====================================================================
// 通用内容：原生包共享的配置模板
// =====================================================================
const nativeEnv = `# 数据库 / 缓存（默认用 docker-compose.db.yml 起的容器，宿主机端口 5433 / 6380）
DATABASE_URL="postgresql://zaem:zaem_password@localhost:5433/zaem_db?schema=public"
REDIS_URL="redis://localhost:6380"
JWT_SECRET="请改成一段足够长的随机字符串"
PORT=3001
# 后端直接托管前端构建产物
CLIENT_DIST_DIR="../client/dist"
# 摄像头 go2rtc 桥（原生模式下 localhost 即可）
GO2RTC_API_URL="http://localhost:1984"
GO2RTC_RTSP_URL="rtsp://localhost:8554"
XIAOMI_USERNAME=""
XIAOMI_PASSWORD=""
`;

const dbCompose = `services:
  postgres:
    image: postgres:16-alpine
    container_name: zaem-native-postgres
    restart: always
    environment:
      POSTGRES_USER: zaem
      POSTGRES_PASSWORD: zaem_password
      POSTGRES_DB: zaem_db
    ports:
      - "5433:5432"
    volumes:
      - zaem_native_pg:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: zaem-native-redis
    restart: always
    command: redis-server --appendonly yes
    ports:
      - "6380:6379"
    volumes:
      - zaem_native_redis:/data

volumes:
  zaem_native_pg:
  zaem_native_redis:
`;

function copyNodeModules(destRoot) {
  // 复制根目录 hoisted node_modules，排除 workspace 软链接 @zaem（避免递归复制源码/坏链接）
  const src = path.join(ROOT, 'node_modules');
  const dest = path.join(destRoot, 'node_modules');
  if (!fs.existsSync(src)) return;
  mkdir(dest);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(src, s);
      if (rel === '') return true;
      const parts = rel.split(path.sep);
      const top = parts[0];
      // 跳过 workspace 软链接：@zaem/server、@zaem/shared、zhirai-client
      return top !== '@zaem' && top !== 'zhirai-client';
    },
  });
}

function buildNative(dirName, isWindows) {
  const N = path.join(RELEASE, dirName);
  mkdir(N);

  cpDir(path.join(ROOT, 'server', 'dist'), path.join(N, 'server', 'dist'));
  cpDir(path.join(ROOT, 'server', 'node_modules'), path.join(N, 'server', 'node_modules'));
  cpDir(path.join(ROOT, 'server', 'prisma'), path.join(N, 'server', 'prisma'));
  cpFile(path.join(ROOT, 'server', 'package.json'), path.join(N, 'server', 'package.json'));
  cpFile(path.join(ROOT, 'server', 'tsconfig.json'), path.join(N, 'server', 'tsconfig.json'));
  cpDir(path.join(ROOT, 'client', 'dist'), path.join(N, 'client', 'dist'));
  cpDir(path.join(ROOT, 'shared'), path.join(N, 'shared'));
  write(path.join(N, 'go2rtc', 'go2rtc.yaml'), go2rtcTemplate);

  write(path.join(N, 'server', '.env'), nativeEnv);
  write(path.join(N, 'docker-compose.db.yml'), dbCompose);

  if (isWindows) {
    // Windows：捆绑已就绪的 node_modules（含 Windows 版 Prisma 引擎），免 npm install
    copyNodeModules(N);
    cpFile(path.join(ROOT, 'go2rtc', 'go2rtc.exe'), path.join(N, 'go2rtc', 'go2rtc.exe'));
    const ffmpegSrc = 'D:\\AI-Content-OS\\AI-Content-OS\\tools\\ffmpeg.exe';
    cpFile(ffmpegSrc, path.join(N, 'tools', 'ffmpeg.exe'));
  }

  return N;
}

// =====================================================================
// 2) Linux 原生包
// =====================================================================
const L = buildNative('zaem-linux', false);
write(path.join(L, 'install.sh'), `#!/bin/sh
set -e
cd "$(dirname "$0")"
echo "[1/5] 校验 Node.js"
if ! command -v node >/dev/null 2>&1; then echo "需要 Node.js 18+（建议 20/22）"; exit 1; fi
echo "[2/5] 安装系统依赖 ffmpeg（如已安装可跳过）"
if command -v ffmpeg >/dev/null 2>&1; then echo "ffmpeg 已存在：$(command -v ffmpeg)"; else
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y ffmpeg
  else
    echo "未检测到 apt-get，请手动安装 ffmpeg 并加入 PATH"
    exit 1
  fi
fi
echo "[3/5] 启动数据库(Postgres/Redis)容器"
if command -v docker >/dev/null 2>&1; then docker compose -f docker-compose.db.yml up -d; else echo "需要 Docker 运行数据库，或自行准备 Postgres/Redis 并修改 server/.env"; exit 1; fi
echo "[4/5] 安装后端依赖并生成 Prisma 客户端（Linux 引擎），初始化数据库"
cd server
npm install
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
cd ..
echo "[5/5] 下载 go2rtc（Linux）"
if [ ! -f go2rtc/go2rtc ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) G=amd64;; aarch64) G=arm64;; *) echo "不支持的架构 $ARCH"; exit 1;; esac
  curl -L -o go2rtc/go2rtc "https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_$G" || echo "go2rtc 下载失败，可手动放置二进制到 go2rtc/go2rtc"
  chmod +x go2rtc/go2rtc 2>/dev/null || true
fi
echo "安装完成，运行 ./start.sh 启动"
`);

write(path.join(L, 'start.sh'), `#!/bin/sh
set -e
cd "$(dirname "$0")"
# 1) 数据库
if command -v docker >/dev/null 2>&1; then docker compose -f docker-compose.db.yml up -d; fi
# 2) go2rtc（摄像头桥）
if [ -x go2rtc/go2rtc ]; then (cd go2rtc && nohup ./go2rtc >/dev/null 2>&1 &) ; fi
# 3) 后端（托管前端 + API + 流）
cd server
node dist/server/src/index.js
`);

// =====================================================================
// 3) Windows 原生包
// =====================================================================
const W = buildNative('zaem-windows', true);
write(path.join(W, 'start.ps1'), `$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1) 数据库
if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose -f docker-compose.db.yml up -d
}

# 2) go2rtc（摄像头桥）
if (Test-Path "$PSScriptRoot\\go2rtc\\go2rtc.exe") {
  Start-Process -FilePath "$PSScriptRoot\\go2rtc\\go2rtc.exe" -WorkingDirectory "$PSScriptRoot\\go2rtc" -WindowStyle Hidden
}

# 3) 后端（托管前端 + API + 流）
$env:PATH = "$PSScriptRoot\\tools;$env:PATH"
Set-Location "$PSScriptRoot\\server"
node dist/server/src/index.js
`);

write(path.join(W, 'install.ps1'), `$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Write-Host "[1/3] 校验数据库容器"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "需要 Docker 运行数据库，或自行准备 Postgres/Redis 并修改 server\\.env"
  exit 1
}
docker compose -f docker-compose.db.yml up -d
Write-Host "[2/3] 初始化数据库（迁移 + 种子）"
Set-Location "$PSScriptRoot\\server"
npx prisma migrate deploy
npx prisma db seed
Write-Host "[3/3] 完成，运行 start.ps1 启动"
`);

// =====================================================================
// 压缩
// =====================================================================
function sh(cmd) {
  console.log('> ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

try { sh(`tar -czf "${path.join(RELEASE, 'zaem-container.tar.gz')}" -C "${RELEASE}" zaem-container`); } catch (e) { console.warn('tar 压缩容器包失败：', e.message); }
try { sh(`tar -czf "${path.join(RELEASE, 'zaem-linux.tar.gz')}" -C "${RELEASE}" zaem-linux`); } catch (e) { console.warn('tar 压缩 Linux 包失败：', e.message); }
try { sh(`tar -c -f "${path.join(RELEASE, 'zaem-windows.zip')}" --format zip -C "${RELEASE}" zaem-windows`); } catch (e) { console.warn('压缩 Windows 包失败：', e.message); }

console.log('\\n打包完成，产物位于：', RELEASE);
for (const f of fs.readdirSync(RELEASE)) {
  const p = path.join(RELEASE, f);
  const st = fs.statSync(p);
  console.log((st.isDirectory() ? '[DIR]  ' : '[FILE] ') + f + (st.isFile() ? ` (${(st.size / 1024 / 1024).toFixed(1)} MB)` : ''));
}
