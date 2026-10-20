# 局域网摄像头接入（MVP）实现说明

- **状态**：✅ 已用**真实摄像头**（水星 MERCURY MIPC852W）完成端到端联调；监控墙直播 / 快照 / 录像均验证通过
- **日期**：2026-10-18
- **目标**：在**保留现有 UI** 的前提下，让系统可以直接接入局域网 ONVIF / RTSP 摄像头，完全本地运行、不依赖小米云；同时保留原有米家云摄像头能力。
- **关联**：[`UPGRADE-PLAN-2026-10-18.zh-CN.md`](./UPGRADE-PLAN-2026-10-18.zh-CN.md)（阶段 D 提前落地）

---

## 0. 效果截图（真实摄像头实测）

监控墙（真实画面，局域网摄像头带「局域网」角标、LIVE 状态、名称"水星 MIPC852W"）：

![真实摄像头监控墙](./images/lan-camera-real-mercury-live.png)

本地隔离环境（模拟 ONVIF + 测试视频源）的添加/测试连接界面：

![添加摄像头并测试连接](./images/lan-camera-add-dialog-test.png)

---

## 1. 实现了什么

### 1.1 摄像头管理（新）

- 监控墙右上角新增 **「＋添加摄像头」** 按钮，打开「摄像头接入管理」弹窗：
  - 已接入的局域网摄像头列表（在线状态 / IP / 型号 / 编辑 / 测试 / 删除）
  - **发现 ONVIF 设备**（WS-Discovery 组播；发现不到时可手动填 IP）
  - 添加表单：名称、IP、ONVIF 端口、ONVIF 账号、ONVIF 密码
  - **测试连接**：自动完成 ONVIF 探测 → 取主/子码流 RTSP → 用 ffmpeg 实际拉流验证 → 显示品牌/型号/分辨率/编码/RTSP/快照/档位
  - **高级选项 / 手动 RTSP**：ONVIF 不可用时直接填 RTSP 地址；可配置子码流、快照地址、是否转码 H.264、是否支持 PTZ
  - 编辑时自动回填已保存配置
- 权限：`admin` / `boss` 可添加/编辑/删除/测试；普通用户只读。

### 1.2 ONVIF 协议（自研，零新增依赖）

`server/src/modules/system/lib/onvif.ts`：

- **WS-Discovery** 组播发现（UDP 239.255.255.250:3702）
- **ONVIF SOAP 调用**：`GetDeviceInformation` / `GetCapabilities` / `GetProfiles` / `GetStreamUri` / `GetSnapshotUri`
- **WS-Security UsernameToken（PasswordDigest）** 认证（含 Nonce / Created / SHA1 摘要），同时附带 HTTP Basic 兼容部分设备
- **摄像头时钟偏差校正**：先发未认证 `GetSystemDateAndTime`，按摄像头时间修正 WS-Security 时间戳（避免摄像头时间不准导致认证失败）
- **媒体服务地址自动发现**：优先 `GetCapabilities.Media.XAddr`，失败回退 `/onvif/media_service`、`/onvif/Media`
- **主/子码流自动选择**：H264 优先、分辨率排序；PTZ 能力自动识别
- **RTSP 品牌模板兜底**：海康 / 大华 / TP-Link-Tapo / 宇视 / Reolink / 通用模板
- **RTSP 实测**：用 ffmpeg 拉流 1 秒验证，并解析出编码/分辨率摘要

### 1.3 直播 / 快照 / 录像

| 能力 | 实现方式 |
|---|---|
| 实时画面 | 局域网摄像头 RTSP → 复用项目已有 ffmpeg HLS 代理（`ensureCameraStreamProxy`）→ 前端原有 hls.js 播放器不变 |
| 快照 | 优先 ffmpeg 从 RTSP 抓真实帧（JPEG），失败回退 ONVIF 快照 URL；房间卡片/监控墙缩略图自动生效 |
| 录像 | 录像源改为设备自身 RTSP（连续录制 / 智能侦测 / 录制计划都支持），录像回放页不变 |
| 监控墙 | 统一列表：局域网摄像头 + 米家云摄像头混排，局域网摄像头带「局域网」角标 |
| 仪表盘 | 新摄像头自动进入「摄像头」分类，点卡片可打开原有摄像头详情/实时画面（深链 `/?camera=<did>`） |

### 1.4 存储结构（不新增数据表，零迁移风险）

复用 `Device.model` 的 JSON（与项目原有摄像头配置方式一致），新增 `camera.lan` 子对象：

```json
{
  "ownership": "other",
  "source": "lan_discovery",
  "manualCategory": "camera",
  "ipAddress": "192.168.41.50",
  "vendorName": "Hikvision",
  "model": "Hikvision DS-2CD...",
  "camera": {
    "online": true,
    "brand": "Hikvision",
    "model": "DS-2CD...",
    "hasPTZ": false,
    "hasRecording": true,
    "manualSnapshotUrl": "http://192.168.41.50/...",
    "manualAuthUsername": "admin",
    "manualAuthPassword": "***",
    "manualAuthType": "digest",
    "lan": {
      "source": "onvif",
      "ip": "192.168.41.50",
      "port": 80,
      "username": "admin",
      "password": "***",
      "brand": "Hikvision",
      "model": "DS-2CD...",
      "rtspUrl": "rtsp://admin:***@192.168.41.50:554/Streaming/Channels/101",
      "subRtspUrl": "rtsp://admin:***@192.168.41.50:554/Streaming/Channels/102",
      "snapshotUrl": "http://192.168.41.50/...",
      "hasPTZ": false,
      "transcodeH264": true,
      "addedAt": "2026-10-18T...",
      "updatedAt": "2026-10-18T..."
    }
  }
}
```

设备 DID 规则：
- 手动新增：`LAN_CAM_<IP 下划线>`（如 `LAN_CAM_192_168_41_50`），带 `LAN_` 前缀以复用现有"局域网设备"在线判定与去重逻辑；
- 若该 IP 已被局域网扫描入库（`LAN_<MAC>`），则**复用原设备记录**，不产生重复卡片。

---

## 2. 新增 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system/cameras` | 统一摄像头列表（局域网 + 米家云；纯 DB，不触发小米云） |
| POST | `/api/system/cameras/discover` | WS-Discovery 发现 ONVIF 设备 |
| POST | `/api/system/cameras/probe` | 探测指定 IP（ONVIF / RTSP），不落库 |
| POST | `/api/system/cameras/lan` | 新增局域网摄像头 |
| PUT | `/api/system/cameras/lan/:did` | 更新局域网摄像头 |
| GET | `/api/system/cameras/lan/:did/config` | 读取配置（编辑回填） |
| POST | `/api/system/cameras/lan/:did/test` | 测试已保存摄像头（RTSP + HLS） |
| DELETE | `/api/system/cameras/lan/:did` | 删除局域网摄像头 |

> 复用原有接口：`GET /api/system/device/:did/camera_stream`（直播地址）、`GET /api/system/device/:did/snapshot`（快照）、`/camera_record/*`（录像）、`/camera/schedules`（录像计划）。

---

## 3. 涉及文件

**新增**
- `server/src/modules/system/lib/onvif.ts` — ONVIF 客户端（发现/探测/RTSP 模板/实测/时钟校正）
- `server/src/modules/system/lan-camera.service.ts` — 局域网摄像头业务（列表/探测/保存/删除/流/测试/存储）
- `server/src/modules/system/lan-camera.controller.ts` — 摄像头管理 HTTP 接口
- `client/src/components/camera/CameraManageDialog.tsx` — 摄像头接入管理弹窗
- `server/prisma/migrations/20261018000000_fix_device_local_control_columns/migration.sql` — 修复 schema 漂移（见第 5 节）

**修改**
- `server/src/modules/system/system.routes.ts` — 注册摄像头管理路由
- `server/src/modules/system/system.controller.ts` — `camera_stream` 增加局域网分支；录像源支持局域网 RTSP
- `server/src/modules/system/system.service.ts` — 快照支持局域网 RTSP 抓帧；录像计划引擎支持局域网 RTSP；抽取通用 ffmpeg 抓帧
- `client/src/lib/api.ts` — 摄像头管理 API 与类型
- `client/src/pages/CameraWallPage.tsx` — 统一列表 + 「添加摄像头」入口 + 局域网角标 + 保存后刷新流

---

## 4. 验证记录（隔离环境，本地）

**环境**：本机 Docker 内独立测试库（`zaem_devtest`，不碰现有数据）+ 独立 Redis DB + 本地 mock ONVIF 服务 + go2rtc 提供测试 RTSP 源（H.264 640x360）。全程**未使用真实小米账号、未修改真实数据**。

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 后端 `npm run build` / 前端 `npm run build` | ✅ 通过 |
| 2 | ONVIF 探测（GetDeviceInformation → GetCapabilities → GetProfiles → GetStreamUri → GetSnapshotUri） | ✅ 品牌/型号/档位（1920x1080 主 + 640x360 子）/PTZ 能力/快照地址全部解析正确 |
| 3 | RTSP 实测（ffmpeg 拉流验证） | ✅ 成功，识别出 H264 640x360 |
| 4 | 新增摄像头 → 列表显示 | ✅ `LAN_CAM_127_0_0_1`，在线、型号、IP 正确 |
| 5 | 实时流（`camera_stream`） | ✅ `hlsReady=true`，`/streams/hls/.../stream.m3u8` 返回 200 |
| 6 | 监控墙浏览器实测 | ✅ 测试画面正常播放（截图见会话记录），局域网/LIVE 角标正常 |
| 7 | 快照 | ✅ `image/jpeg`，~26KB |
| 8 | 连续录制 | ✅ 启动/状态/停止正常，生成 mp4（约 512KB），录像列表可查 |
| 9 | 仪表盘分类 | ✅ 新摄像头出现在 `category=camera`，在线 |
| 10 | 权限 | ✅ 普通用户写入返回 403，读取允许 |
| 11 | 编辑回填 | ✅ 密码/RTSP/快照/PTZ/转码开关完整回填 |
| 12 | 删除 | ✅ 删除后列表为空，流进程停止 |
| 13 | 全新数据库 `prisma migrate deploy` | ✅ 迁移历史与 schema 差异为空（修复后） |

> 说明：测试中 ONVIF 为 mock 服务，用于验证协议解析与整条管道；真实摄像头联调见第 6 节。

---

## 5. 顺带修复：数据库 schema 漂移

**发现**：`schema.prisma` 里 `Device` 的 `localip / controlProtocol / controlConfig / controlUpdatedAt` 四列**不在任何迁移里**（之前是用 `prisma db push` 直接同步到现有库的）。后果：
- 现有生产库能用（列已存在）；
- 但**全新部署执行 `prisma migrate deploy` 会缺这 4 列**，局域网控制/摄像头直接报错。

**修复**：新增幂等迁移 `20261018000000_fix_device_local_control_columns`，使用 `ADD COLUMN IF NOT EXISTS`：
- 现有库（列已存在）→ 全部跳过，只记录迁移版本；
- 全新库 → 正常补列；
- 不改动/删除任何已有数据。

已用全新数据库验证：`migrate deploy` 后 `migrate diff` 输出为空（迁移历史与 schema 完全一致）。

---

## 6. 真实 ONVIF 摄像头联调步骤

### 6.0 已联调设备记录（2026-10-18）

| 项 | 结果 |
|---|---|
| 设备 | **水星 MERCURY MIPC852W**（固件 `1.0.2 Build 241127`） |
| 发现方式 | WS-Discovery 自动发现（`MERCURY-IPC`） |
| 实际 IP / ONVIF 端口 | `192.168.41.123` / `2020`（用户最初以为在 `.1`，实际 `.1` 是路由器网关） |
| ONVIF 探测 | ✅ 422ms：厂商 MERCURY、型号 MIPC852W、PTZ=支持 |
| 主码流 | `rtsp://192.168.41.123:554/stream1` —— **实际是 H.265/HEVC 4K（3840×2160）**（ONVIF 标称 H264 不准确） |
| 子码流 | `rtsp://192.168.41.123:554/stream2` —— **H.264 640×360（浏览器可直接播放）** |
| 直播 | ✅ 监控墙正常播放（采用子码流、不转码，CPU 占用低） |
| 快照 | ✅ JPEG，约 45 KB（ffmpeg 从 RTSP 抓帧） |
| 录像 | ✅ 连续录制生成可播放 MP4（H.264 640×360），已改为**分片 MP4**，异常中断后文件仍可播放 |
| 并发限制 | 该摄像头最多允许 **2 路并发 RTSP 连接**（直播 + 录像正常；第 3 路会被拒绝） |

**经验沉淀（已写进代码默认值）**
1. **直播/录像默认走子码流**：很多摄像头主码流是 H.265 4K，浏览器（hls.js）无法直接播放；子码流通常是 H.264，兼容且省 CPU。
2. 探测时会实际用 ffmpeg 拉主/子码流并显示编码信息；若主码流为 H.265 会给出中文提示。
3. 录像容器改为分片 MP4（`frag_keyframe+empty_moov`），进程被强杀/断电时已写入部分仍可播放。
4. `ffmpeg` 的 stderr 现在始终被消费并保留最近错误，避免管道写满阻塞并便于排障。
5. 因为摄像头并发连接有限，**下一步建议**：直播/快照/录像统一从 go2rtc 的本地 RTSP 取流（摄像头只连 1 路），彻底规避并发限制。

### 6.1 操作步骤

摄像头上电、接入局域网后：

1. 打开系统 → **监控墙** → 右上角 **「＋添加摄像头」**；
2. 优先点 **「发现 ONVIF 设备」**：若设备在线且网络允许组播，会列出 IP，点击填入；
3. 若发现不到：手动填 **IP** 和 **ONVIF 端口**（常见 80 / 8000 / 2020 / 8899，看摄像头 App 的 ONVIF 设置）；
4. 填 **ONVIF 账号 / 密码**（不是 App 登录密码，是摄像头"ONVIF 用户"的账号密码，通常需要在摄像头 App 里手动开启 ONVIF 并创建）；
5. 点 **「测试连接」**：
   - 成功 → 显示品牌/型号/分辨率/直播地址，会自动填好；
   - 失败 → 按提示检查端口/账号密码，或展开「高级选项」手动填 RTSP 地址；
6. 点 **「添加摄像头」** → 监控墙出现画面；点击画面可进入房间/摄像头详情看大屏与录像。

> 也可以把摄像头 IP / 品牌型号 / ONVIF 账号密码发我，我直接探测并给出可用的 RTSP 地址。

**常见问题**
- ONVIF 连不上：确认 App 里已开启 ONVIF、端口正确、摄像头与服务器同网段；部分摄像头 ONVIF 要和 RTSP 分开开启。
- 能连上但没画面：多为 RTSP 地址/账号问题，或摄像头只允许同时一个客户端（先关掉 App 的实时预览再试）。
- 画面卡顿：在「高级选项」里关闭"转码为 H.264"（若摄像头本身已是 H.264），可显著降低服务器 CPU。

---

## 7. 已知限制 / 后续改进

| 项 | 说明 | 计划 |
|---|---|---|
| 密码存储 | 沿用项目现有方式存在 `Device.model` JSON 中（明文）；仅本地使用 | 后续统一加密存储（阶段 F） |
| 多摄像头性能 | 每路一个 ffmpeg 进程；1080P 转码较吃 CPU | 后续接入 go2rtc 统一管理流、按需转码、共享会话 |
| WS-Discovery | 部分 AP/摄像头关闭组播时发现不到 | 手动 IP 添加兜底（已支持） |
| 品牌兼容 | 海康/大华/TP-Link/宇视/Reolink 已内置 RTSP 模板；其他品牌依赖 ONVIF 标准 | 真实设备联调后按需补模板 |
| PTZ 控制 | 目前只识别能力与保存开关，PTZ 控制按钮尚未接入局域网摄像头 | 下一阶段：ONVIF ContinuousMove/AbsoluteMove |
| 本地能力探测（空开） | 本次未改动，已实测 10 台 MiIO 可握手 | 按升级方案阶段 C 实施 |
| 登录面板多区域状态 | 本次未改动 | 按升级方案「追加需求」实施 |

---

## 8. 本地验证命令（供参考）

```powershell
# 后端构建
cd server; npm run build

# 前端构建
cd client; npm run build

# 本地隔离联调（示例，需要 Django... 不，需要本地 PostgreSQL/Redis）
# 1) 建测试库并迁移
docker exec zaem-postgres psql -U zaem -d zaem_db -c "CREATE DATABASE zaem_devtest"
$env:DATABASE_URL='postgresql://zaem:change_me_password@localhost:5433/zaem_devtest?schema=public'
cd server; npx prisma migrate deploy; npx ts-node prisma/seed.ts
# 2) 启动后端（PORT=3005，关闭小米云凭据，避免误用真实账号）
$env:XIAOMI_USERNAME=''; $env:XIAOMI_PASSWORD=''; $env:PORT='3005'
node dist/server/src/index.js
# 3) 登录后调用 /api/system/cameras/probe 与 /api/system/cameras/lan
```
