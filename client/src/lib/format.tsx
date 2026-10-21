import type { LucideIcon } from 'lucide-react';
import {
  Wifi,
  Camera,
  Cpu,
  Power,
  SignalHigh,
} from 'lucide-react';
import { DeviceCategory } from '../types';
import { ValueWithUnit, formatValueUnitHtml } from '../components/ui/value-with-unit';

export const powerFormatter = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const energyFormatter0 = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export const energyFormatter1 = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const energyFormatter2 = new Intl.NumberFormat('de-AT', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const currencyFormatter = new Intl.NumberFormat('de-AT', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export const shortDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(dateStr: string | number | Date): string {
  try {
    const d = typeof dateStr === 'object' && dateStr instanceof Date ? dateStr : new Date(dateStr);
    return dateTimeFormatter.format(d);
  } catch {
    return String(dateStr);
  }
}

export function formatShortDateTime(time: string | number | Date): string {
  try {
    const d = typeof time === 'object' && time instanceof Date ? time : new Date(time);
    return shortDateTimeFormatter.format(d);
  } catch {
    return String(time);
  }
}

export function formatEnergy(
  value: number,
  digits: 0 | 1 | 2 = 2,
  classNameOverride?: Partial<{ valueClassName: string }>,
) {
  const formatter =
    digits === 0
      ? energyFormatter0
      : digits === 1
        ? energyFormatter1
        : energyFormatter2;
  return (
    <ValueWithUnit
      value={formatter.format(value)}
      unit="kWh"
      valueClassName={classNameOverride?.valueClassName ?? 'font-semibold'}
    />
  );
}

export function formatPower(
  value: number,
  classNameOverride?: Partial<{ valueClassName: string }>,
) {
  return (
    <ValueWithUnit
      value={powerFormatter.format(value)}
      unit="W"
      valueClassName={classNameOverride?.valueClassName ?? 'font-semibold'}
    />
  );
}

export function formatCost(value: number) {
  return currencyFormatter.format(value);
}

export function formatPowerHtml(value: number) {
  return formatValueUnitHtml(powerFormatter.format(value), 'W');
}

export function formatEnergyHtml(value: number, digits: 0 | 1 | 2 = 2) {
  const formatter =
    digits === 0
      ? energyFormatter0
      : digits === 1
        ? energyFormatter1
        : energyFormatter2;
  return formatValueUnitHtml(formatter.format(value), 'kWh');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '0 B';
  const b = Number(bytes);
  if (Math.abs(b) < 1024) return `${b.toFixed(0)} B`;
  const k = b / 1024;
  if (Math.abs(k) < 1024) return `${k.toFixed(1)} KB`;
  const m = k / 1024;
  if (Math.abs(m) < 1024) return `${m.toFixed(2)} MB`;
  return `${(m / 1024).toFixed(2)} GB`;
}

const MEANINGLESS_TEXT_TOKENS: ReadonlySet<string> = new Set([
  '--',
  '-- Mbps',
  '-- 台',
  '-- dBm',
  '0 B',
]);

export function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  const text = String(value).trim();
  if (!text) return false;
  return !MEANINGLESS_TEXT_TOKENS.has(text);
}

export const CATEGORY_ICON_MAP: Record<DeviceCategory, LucideIcon> = {
  [DeviceCategory.CIRCUIT_BREAKER]: Power,
  [DeviceCategory.CAMERA]: Camera,
  [DeviceCategory.WIFI_AP]: Wifi,
  [DeviceCategory.FIVE_G_CPE]: SignalHigh,
  [DeviceCategory.SMART_APPLIANCE]: Cpu,
  [DeviceCategory.OTHER]: Cpu,
} as const;

export const CATEGORY_TONE_CLASS_MAP: Record<DeviceCategory, string> = {
  [DeviceCategory.CIRCUIT_BREAKER]:
    'border-emerald-400/50 bg-emerald-50 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  [DeviceCategory.CAMERA]:
    'border-indigo-400/50 bg-indigo-50 text-indigo-700 dark:border-indigo-700/60 dark:bg-indigo-950/40 dark:text-indigo-300',
  [DeviceCategory.FIVE_G_CPE]:
    'border-amber-400/60 bg-amber-50 text-amber-800 dark:border-amber-600/50 dark:bg-amber-950/40 dark:text-amber-300',
  [DeviceCategory.WIFI_AP]:
    'border-sky-400/50 bg-sky-50 text-sky-700 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-300',
  [DeviceCategory.SMART_APPLIANCE]:
    'border-violet-400/50 bg-violet-50 text-violet-700 dark:border-violet-700/60 dark:bg-violet-950/40 dark:text-violet-300',
  [DeviceCategory.OTHER]:
    'border-slate-400/50 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-300',
} as const;

export const CATEGORY_PRIORITY: ReadonlyArray<DeviceCategory> = [
  DeviceCategory.CIRCUIT_BREAKER,
  DeviceCategory.CAMERA,
  DeviceCategory.FIVE_G_CPE,
  DeviceCategory.WIFI_AP,
  DeviceCategory.SMART_APPLIANCE,
  DeviceCategory.OTHER,
] as const;

export type DeviceCategoryCounter = Record<DeviceCategory, number>;

export function createEmptyCategoryCounter(): DeviceCategoryCounter {
  return {
    [DeviceCategory.CIRCUIT_BREAKER]: 0,
    [DeviceCategory.CAMERA]: 0,
    [DeviceCategory.WIFI_AP]: 0,
    [DeviceCategory.FIVE_G_CPE]: 0,
    [DeviceCategory.SMART_APPLIANCE]: 0,
    [DeviceCategory.OTHER]: 0,
  };
}

export interface MinimalDeviceLike {
  id?: string | null;
  did?: string | null;
  category?: DeviceCategory | string | null;
}

export function countDeviceCategories<T extends MinimalDeviceLike>(
  devices: T[],
): DeviceCategoryCounter {
  const out = createEmptyCategoryCounter();
  const seen = new Set<string>();
  for (const d of devices) {
    const key = d.id ?? d.did;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cat = String(d.category ?? DeviceCategory.OTHER) as DeviceCategory;
    out[cat] = (out[cat] ?? 0) + 1;
  }
  return out;
}

export function pickPrimaryCategory<T extends MinimalDeviceLike>(
  devices: T[],
): DeviceCategory {
  if (!devices.length) return DeviceCategory.OTHER;
  const counts = countDeviceCategories(devices);
  let best = DeviceCategory.OTHER;
  let bestCount = -1;
  for (const c of CATEGORY_PRIORITY) {
    const n = counts[c] ?? 0;
    if (n > bestCount) {
      bestCount = n;
      best = c;
    }
  }
  return best;
}

export function progressColorForPercent(percent: number): string {
  if (percent >= 95) return 'bg-red-500';
  if (percent >= 90) return 'bg-orange-500';
  if (percent >= 80) return 'bg-yellow-500';
  return 'bg-green-500';
}

export function getCategoryIcon(cat: DeviceCategory): LucideIcon {
  return CATEGORY_ICON_MAP[cat] ?? CATEGORY_ICON_MAP[DeviceCategory.OTHER];
}

export function getCategoryToneClass(cat: DeviceCategory): string {
  return (
    CATEGORY_TONE_CLASS_MAP[cat] ?? CATEGORY_TONE_CLASS_MAP[DeviceCategory.OTHER]
  );
}

export function normalizeMac(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).trim().toUpperCase().replace(/[^A-F0-9]/g, '');
}
