# Changelog

This document records the most important repository updates so it is easy to see what changed in each round of work.

## 2026-08-16

### Database Status

- Ran `prisma migrate deploy` against the configured PostgreSQL database.
- Result: **no pending migrations**. The database schema is already up to date.

### Xiaomi and Multi-Region Account Sync

- Reworked the Xiaomi account sync page so region-based login is managed from a single entry point.
- Added separate visible status cards for mainland China and Europe / international regions.
- Added dedicated device-list endpoints for the main Xiaomi session and the secondary region session.
- Updated the device sync pipeline to merge devices from both available Xiaomi sessions.
- Removed the duplicated EU login form from the camera card and redirected the flow into the unified account-sync entry.

### Smart Breaker Data Parsing and Database Protection

- Fixed cumulative-energy parsing for `lxzn.switch.cbcsmj` smart breakers.
- Restored the correct unit decoding for cumulative energy, current, and voltage.
- Added runtime sanitization before writing Xiaomi telemetry into the database.
- Added range guards and cumulative-energy monotonic protection to block corrupted spikes from being written into `Device` runtime fields.
- Applied those guards to real-time refresh, power-on, power-off, and Xiaomi sync database writes.

### Xiaomi Offline and Missing-Device Handling

- Added handling for devices that disappear from the current Xiaomi response.
- Missing devices are now marked offline instead of remaining silently stale in the management UI.

### Xiaomi Login and Verification Flow Cleanup

- Improved login and verification status reporting so the UI shows persistent, readable progress instead of short-lived toast-only messages.
- Prevented the EU region flow from silently falling back to the main-account credentials.
- Added a dedicated EU continue-login route so browser verification can resume the Xiaomi session flow.
- Improved failure-state persistence so verification errors update the visible status instead of leaving the UI stuck on “code sent”.
- Switched EU / international challenge handling to prefer browser verification instead of forcing the email-code path first.
- Updated the verification-page opening flow so it refreshes status before opening a link and no longer reuses the previous stale URL as a fallback.

### Frontend and UI Refinements

- Improved the account-sync page layout and state handling for region login cards.
- Adjusted the network device page to use cleaner short vendor naming instead of long raw device-brand strings.
- Continued compactness and deduplication work across dashboard, charts, logs, alarms, and settings pages.

### Shared Library Refactoring and Deduplication

- Extracted repeated formatting, mapping, and runtime-parsing logic into shared libraries.
- Introduced a shared `format` module so number, date, and energy formatting is no longer duplicated across pages.
- Introduced a shared `status-maps` module to replace scattered switch branches in alarm and room-card views.
- Introduced shared `crypto-helpers`, `http-auth`, and `device-runtime` modules to unify digest/basic-auth algorithms and camera/gateway runtime extraction.
- Extracted reusable system-settings option definitions to reduce duplicated option blocks.
- Slimmed down several large core files, including `RoomCard.tsx`, `system.service.ts`, and `xiaomi.adapter.ts`.
- Both `server` and `client` now pass TypeScript checks with zero errors after the refactor.

### Security and Repository Hygiene

- Removed a debug script that contained a hardcoded admin JWT token.
- Removed temporary debug screenshots from the repository root.
- Added `.gitignore` rules for Prisma generated output and local debug artifacts so they cannot be committed again.

### Repository Documentation

- Converted the main repository documentation to English.
- Rewrote `README.md` in English.
- Rewrote this `CHANGELOG.md` in English and expanded the latest update record.

## 2026-08-11

### Remote Frontend Connectivity Fix

- Fixed a production issue where the deployed static frontend incorrectly pointed API and Socket.IO traffic back to itself.
- Rebuilt the frontend so API and WebSocket targets point to the real backend entry again.
- Addressed common symptoms such as:
  - failed `/socket.io` connections
  - module script loading failures
  - static assets or API calls falling back to `text/html`
- Documented that the remote backend was still using a Cloudflare Quick Tunnel at that time, which remained a temporary entry point.

### Dashboard Alert Summary Refresh

- Reworked the top alert area into two compact summary cards.
- One card shows the latest alert.
- The other shows rooms that were already cut off because of limit overflow.
- The latest-alert card now auto-dismisses after a short delay to reduce visual clutter.

### Alarm Center Semantics

- Reclassified `80% / 90% / 95%` usage events as warnings instead of fault tickets.
- Updated statuses to clearer labels such as:
  - `Needs Attention`
  - `Needs Handling`
  - `Closed`
- Updated action labels for clearer operator behavior.
- Automatically closed records after automatic cut-off or automatic recovery when the event lifecycle was complete.

### Audit Log Readability

- Replaced raw JSON-style log details with more readable human-facing summaries.
- Improved log formatting to clearly show:
  - action type
  - source channel
  - room / device
  - login location
  - login device
  - success or failure result
  - failure reason

### Operation Source and Identity Attribution

- Added request-context extraction for better operation labeling.
- Improved automatic identification of action sources such as:
  - web desktop
  - web mobile
  - app
  - API client
  - system automation

### Automatic Cut-Off and Restore Auditing

- Clearly separated manual cut-off, automatic cut-off, manual restore, and automatic restore in the logs.
- Added richer device-control log context for rooms, devices, and execution results.
- Logged cooldown-protection interceptions with clearer messages and remaining-wait information.

### Xiaomi Device Control Confirmation

- Added post-command state confirmation after power on/off operations.
- Marked operations successful only after the device actually reached the target state.
- Reduced false-success records where the backend reported success but the device did not really change state.

### Frontend / API Behavior Fixes

- Improved log page rendering for human-readable details.
- Added filter-aware record clearing in the alarm center.
- Further tightened filter layout on alarm and operation-log pages.
- Updated frontend API error handling to prefer real backend messages.
- Refined Socket target derivation to better follow the backend API address.

### Deployment and Remote Runtime

- Adjusted the remote Docker Compose setup so critical variables are read from `.env`.
- Relaxed CORS and Socket.IO settings for the current proxy-based deployment pattern.
- Updated remote frontend assets and cleaned cached static resources.

## Notes

- This file is intended to answer “what changed in the repository recently?”
- For a broader product and architecture overview, see [`README.md`](./README.md).
