# ZHIRAI Apartment Energy Manager

ZHIRAI Apartment Energy Manager is a centralized web platform for apartment, dormitory, rental, and multi-room electricity management. It connects Xiaomi / Mi Home power control devices and turns scattered device status, real-time power, daily consumption, historical energy, alerts, manual cut-off, and automatic restore flows into a single operational dashboard.

In practical terms, the project is built to solve these problems:

- Too many rooms and devices to manage from separate apps
- The need to track real daily energy usage instead of only instantaneous power
- Room-level daily energy limits with automatic power cut-off
- Automatic next-day power recovery without manual intervention
- Alerting, historical trends, and audit logs in one place
- Direct mobile browser access without maintaining a separate native app

Keywords: `Xiaomi`, `Mi Home`, `Apartment Energy Manager`, `Smart Power Control`, `Room Electricity Dashboard`, `Energy Control Platform`

## Latest Updates

The latest update notes are maintained in [`CHANGELOG.md`](./CHANGELOG.md).

Recent highlights include:

- Refined Xiaomi account sync and multi-region login handling
- Improved cumulative energy parsing and database write guards for smart breakers
- Added stronger offline detection for missing Xiaomi devices
- Reworked dashboard alert summaries and alarm-center behavior
- Improved audit logs and operation-source labeling
- Continued cleanup of duplicated logic across client and server modules

## What This System Does

If you are seeing this repository for the first time, the simplest way to understand it is to look at what you can actually do with it.

### 1. Connect Xiaomi / Mi Home Devices

The system can sign in to Xiaomi / Mi Home, discover supported devices, and sync them into this platform.

After connection, you can:

- Check whether each device is online
- Map devices to rooms or spaces
- Refresh synced device status from the management system
- Avoid switching back and forth between Mi Home and the admin dashboard

Supported login flows currently include:

- Username and password login
- Session-based login
- Email verification code flow
- Browser-based security verification flow

This means the project is not just a static dashboard. It includes a real device-ingestion pipeline.

### 2. Dashboard-First Global View

The dashboard is designed to expose the full operational picture immediately.

It shows:

- Total energy used today
- Total cost today
- Online and offline device counts
- Unresolved alert counts
- The latest alert
- Real-time room power
- Per-room daily energy usage
- Per-room daily limit
- Per-room cut-off state
- Per-room limit enforcement toggle

The goal is to let an operator instantly see which rooms are actively consuming power, which ones are close to limit, which ones have already been cut off, and whether action is needed.

### 3. Room-Level Control

The system is organized by room or space instead of a single coarse total meter view.

Each room card can directly support:

- Renaming the room or space
- Viewing real-time power
- Viewing cumulative energy
- Viewing today’s usage versus the daily limit
- Editing the daily limit
- Enabling or disabling automatic cut-off
- Manually cutting power immediately
- Opening the detail page for historical data

This matters in real deployments because different rooms usually need different limits, policies, and interventions.

### 4. Automatic Cut-Off, Not Just Monitoring

This is not only a monitoring tool. It is also an execution system.

Each room can be assigned its own daily limit, for example:

- Room A: `10 kWh / day`
- Room B: `8 kWh / day`
- Room C: `15 kWh / day`

Once limit enforcement is enabled, the platform will:

- Continuously track the room’s daily usage
- Trigger warnings at configured thresholds
- Cut power automatically once the limit is fully reached
- Write both an alert record and an operation log

### 5. Automatic Next-Day Recovery

Automatic cut-off is incomplete without a recovery flow.

The project includes a full business-day reset pipeline:

- The daily reset time is configurable in system settings
- A new business day triggers reset logic
- Rooms that were cut off because of limit enforcement can be restored automatically

### 6. Energy Statistics Prefer Real Cumulative Values

One of the most important design choices in this project is that energy statistics should not rely on naive power-times-time estimates.

The system prefers real cumulative device readings whenever possible, in order to reduce:

- Drift caused by power fluctuations
- Missing data when the page is not open
- Artificial jumps caused by refresh timing
- Mismatch between daily totals and the device’s actual meter data

Current statistics include:

- Today
- Yesterday comparison
- Month-to-date
- Year-to-date
- 24-hour trend
- 7-day trend
- 30-day trend
- 12-month trend
- Room ranking
- Cost trend

### 7. Dedicated Trend Charts

The chart page is intended for long-term analysis, not just decoration.

It is used to:

- Observe day, week, month, and year trends
- Compare room rankings
- Analyze energy and cost changes
- Spot rooms with abnormal increases

This is especially useful for operators who need to manage ongoing electricity behavior across multiple rooms.

### 8. Per-Room Detail Pages

Dashboard cards are for fast actions. Room detail pages are for full-room context.

A room detail page can show:

- Current real-time power
- Voltage and current readings
- Today’s usage
- Yesterday / month / year comparisons
- 24-hour, 7-day, 30-day, and 12-month trends
- Device status
- Current power supply state

It also supports direct actions such as:

- Manual cut-off
- Restore power
- Rename room or space

### 9. Centralized Alert Center

The system supports automatic alerts based on energy usage ratio thresholds.

Current built-in thresholds include:

- `80%`
- `90%`
- `95%`

Once triggered, alerts are surfaced in:

- The dashboard
- The sidebar summary
- The alert center

This allows the operator to react to issues without constantly watching card colors or raw power values.

### 10. Audit Logs

The platform records operational events so investigations do not rely on guesswork.

Logged actions include:

- Login
- Device sync
- Limit changes
- Alert changes
- Manual power cut-off
- Automatic power cut-off
- Power recovery
- System setting updates

The log page supports filtering for common audit questions such as:

- Who changed a room limit
- Whether a cut-off was manual or automatic
- Whether power was actually restored on a given day

### 11. Business Time Zone Handling

Cloud-side Xiaomi data does not always align with the local business calendar, especially in overseas deployments.

The system therefore supports business time zone logic for:

- Today’s totals
- 24-hour trends
- Day boundaries
- Month boundaries
- Daily reset timing
- Automatic restore timing

This is especially important for European deployments where a China-default time model would be incorrect.

### 12. Mobile Browser Usability

The system is responsive and can be used directly from a mobile browser.

Mobile-usable capabilities include:

- Dashboard browsing
- Room-card viewing
- Limit editing
- Limit toggle switching
- Chart browsing
- Room detail access
- Manual cut-off and restore

## Main Pages

### Dashboard

Used for:

- Overall daily power and cost monitoring
- Online/offline visibility
- Latest alert visibility
- Global quick actions
- Per-room direct actions

### Charts

Used for:

- Trend analysis
- Time-range comparisons
- Room ranking
- Cost movement analysis

### Room Detail

Used for:

- Single-room real-time monitoring
- Historical trend analysis
- Manual cut-off / restore
- Daily, monthly, and yearly comparisons

### System Settings

Used for:

- Electricity pricing
- Alert thresholds
- Business time zone settings
- Daily reset time
- Xiaomi account login
- Device synchronization

### Alert Center

Used for:

- Reviewing unresolved alerts
- Filtering by room
- Filtering by time
- Marking alerts as handled

### Operation Logs

Used for:

- Reviewing important actions
- Tracing cut-off and restore events
- Confirming configuration changes

## Best-Fit Use Cases

This system is a strong fit for:

- Apartment electricity management
- Shared-rental room-level limit enforcement
- Dormitory power cut-off and restore workflows
- Overseas deployments that still rely on Xiaomi / Mi Home devices
- Teams that want monitoring and power control in the same backend

If your use case is just one room with occasional Mi Home checks, this system is probably heavier than necessary. It is intended for multi-room, multi-device, long-running management scenarios.

## Screenshot

![ZHIRAI dashboard overview](./docs/images/zhirai-dashboard-overview.png)

## Tech Stack

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- TanStack Query
- Zustand
- ECharts

### Backend

- Node.js
- Express
- Prisma
- PostgreSQL
- Redis
- Socket.IO
- node-cron

### Deployment

- Docker
- Docker Compose

## Project Structure

```text
client/          Web frontend
server/          API, Xiaomi integration, real-time calculations, scheduled jobs, business logic
shared/          Shared frontend/backend types
deploy/remote/   Remote deployment configuration
docs/images/     Images used in the README
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

The backend environment template is located at:

- `server/.env.example`

Create your local configuration from it:

```bash
cp server/.env.example server/.env
```

At minimum, configure:

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `PORT`
- `CORS_ORIGIN`
- `XIAOMI_USERNAME`
- `XIAOMI_PASSWORD`

Notes:

- Keep real credentials only in your local `.env` file or in server-side environment variables
- Never commit real credentials to the repository

### 3. Start Local Development

```bash
npm run dev
```

Default ports:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`

## Docker Deployment

To run the full stack with containers:

```bash
docker compose up -d
```

Recommended production deployment model:

- PostgreSQL for persistent storage
- Redis for cache and runtime state
- Backend in containers
- Frontend served as static assets or through a web server

## Business Logic Notes

### Automatic Cut-Off

- Each room can have its own daily limit
- Each room can independently enable or disable limit-based cut-off
- Once enabled, reaching `100%` of the limit triggers automatic power cut-off

### Alerts

- Alerts escalate at `80%`, `90%`, and `95%`
- They are displayed in the dashboard, sidebar, and alert center

### Automatic Restore

- The system switches to a new business day based on the configured reset time
- Rooms that were automatically cut off can be restored on the next day

### Real-Time Refresh

- The dashboard continuously refreshes critical state
- Room detail pages also stay updated
- Alerts and operation results are propagated back to the frontend quickly

## Contact

### Technical Support

- [xtang3125@gmail.com](mailto:xtang3125@gmail.com)

### Business Contact

- [txq@zhinian-ai.com](mailto:txq@zhinian-ai.com)

### Discord

- `https://discord.gg/uQRzb53R`

### QQ Group

- `147594586`

### QQ Group Link

- `https://qm.qq.com/q/jGGRuz368w`

## License

This project is licensed under [`PolyForm Noncommercial 1.0.0`](./LICENSE).

Allowed:

- Personal study
- Research
- Testing
- Non-commercial modification

Not allowed:

- Commercial use
- Paid redistribution
- Direct use in commercial products or services
