import type { ElementType, ReactNode } from 'react';
import { Zap, DollarSign, Cpu, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import type { DashboardSummary } from '../../types';
import { cn } from '../../lib/utils';
import { ValueWithUnit } from '../ui/value-with-unit';
import { FeeHint } from '../../components/ui/fee-hint';
import { formatCost, formatEnergy as formatEnergyShared, formatBytes as formatBytesShared } from '../../lib/format';

interface StatsCardsProps {
  summary: DashboardSummary;
  pricePerKwh: number;
}

interface StatItem {
  key: string;
  label: string;
  value?: ReactNode;
  valueNode?: ReactNode;
  icon: ElementType;
  iconBg: string;
  iconColor: string;
  badge?: {
    text: string;
    variant: 'success' | 'danger' | 'warning' | 'default';
  };
}

function formatEnergy(value: number) {
  return formatEnergyShared(value, 2, { valueClassName: 'font-bold' });
}

function formatBytes(value: number) {
  const rawStr = formatBytesShared(value);
  const match = rawStr.match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)$/);
  if (!match) {
    return (
      <ValueWithUnit value="0" unit="B" valueClassName="font-bold" />
    );
  }
  return (
    <ValueWithUnit
      value={match[1]}
      unit={match[2]}
      valueClassName="font-bold"
    />
  );
}

export function StatsCards({ summary, pricePerKwh }: StatsCardsProps) {
  const devices = Array.isArray(summary.devices) ? summary.devices : [];
  const totalCumulativeKwh = devices.reduce(
    (sum, device) => sum + (device.totalKwh ?? 0),
    0,
  );
  const fallbackEnergy = summary.todayTotalUsage > 0
    ? summary.todayTotalUsage
    : totalCumulativeKwh;
  const fallbackCost = summary.todayTotalUsage > 0
    ? summary.estimatedCost
    : totalCumulativeKwh * pricePerKwh;

  const publicNetworkDevices = devices.filter((d) =>
    ['wifi_ap', 'five_g_cpe'].includes(String((d as any).category ?? '')),
  );
  const primaryGateway = publicNetworkDevices
    .filter((d) => String((d as any).category ?? '') === 'wifi_ap')
    .sort((a, b) => {
      const aAny = a as any;
      const bAny = b as any;
      const aScore =
        Number(aAny?.wifiAp?.clientCount ?? 0) * 10 +
        (Array.isArray(aAny?.wifiAp?.meshTopology) ? aAny.wifiAp.meshTopology.length : 0) * 50;
      const bScore =
        Number(bAny?.wifiAp?.clientCount ?? 0) * 10 +
        (Array.isArray(bAny?.wifiAp?.meshTopology) ? bAny.wifiAp.meshTopology.length : 0) * 50;
      return bScore - aScore;
    })[0] as any | undefined;
  const primaryCpe = publicNetworkDevices
    .find((d) => String((d as any).category ?? '') === 'five_g_cpe') as any | undefined;
  const gatewayRxBytes = Number(primaryGateway?.wifiAp?.totalRxBytes ?? 0);
  const gatewayTxBytes = Number(primaryGateway?.wifiAp?.totalTxBytes ?? 0);
  const cpeMonthRxBytes = Number(primaryCpe?.fiveGCpe?.monthRxBytes ?? 0);
  const cpeMonthTxBytes = Number(primaryCpe?.fiveGCpe?.monthTxBytes ?? 0);
  const cpeTotalRxBytes = Number(primaryCpe?.fiveGCpe?.totalRxBytes ?? 0);
  const cpeTotalTxBytes = Number(primaryCpe?.fiveGCpe?.totalTxBytes ?? 0);
  const hasGatewayTraffic = gatewayRxBytes > 0 || gatewayTxBytes > 0;
  const hasCpeMonthlyTraffic = cpeMonthRxBytes > 0 || cpeMonthTxBytes > 0;
  const hasCpeTotalTraffic = cpeTotalRxBytes > 0 || cpeTotalTxBytes > 0;
  const trafficLabel = hasGatewayTraffic
    ? 'WiFi 流量'
    : hasCpeMonthlyTraffic
      ? '网络本月流量'
      : hasCpeTotalTraffic
        ? '网络总流量'
        : 'WiFi 流量';
  const trafficRxBytes = hasGatewayTraffic
    ? gatewayRxBytes
    : hasCpeMonthlyTraffic
      ? cpeMonthRxBytes
      : cpeTotalRxBytes;
  const trafficTxBytes = hasGatewayTraffic
    ? gatewayTxBytes
    : hasCpeMonthlyTraffic
      ? cpeMonthTxBytes
      : cpeTotalTxBytes;
  const trafficSource = hasGatewayTraffic ? '网关' : primaryCpe ? '主路由' : null;
  const wifiClients = Number(primaryGateway?.wifiAp?.clientCount ?? 0);

  const stats: StatItem[] = [
    {
      key: 'energy',
      label: summary.todayTotalUsage > 0 ? '今日总用电' : '当前累计电量',
      value: formatEnergy(fallbackEnergy),
      icon: Zap,
      iconBg: 'bg-blue-500/10',
      iconColor: 'text-blue-500',
    },
    {
      key: 'cost',
      label: summary.todayTotalUsage > 0 ? '今日参考费用' : '累计参考费用',
      value: formatCost(fallbackCost),
      icon: DollarSign,
      iconBg: 'bg-emerald-500/10',
      iconColor: 'text-emerald-500',
      badge: { text: '参考', variant: 'default' },
    },
    {
      key: 'wifi_traffic',
      label: trafficLabel,
      valueNode: (
        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap pt-1 text-[13px] font-bold sm:text-sm">
          <span title="下行" className="min-w-0 truncate">{formatBytes(trafficRxBytes)}</span>
          <span className="shrink-0 text-slate-400 text-[10px]">↓</span>
          <span title="上行" className="min-w-0 truncate">{formatBytes(trafficTxBytes)}</span>
          <span className="shrink-0 text-slate-400 text-[10px]">↑</span>
        </div>
      ),
      icon: Wifi,
      iconBg: 'bg-sky-500/10',
      iconColor: 'text-sky-500',
      badge: wifiClients > 0
        ? { text: `${wifiClients} 客户端`, variant: 'default' }
        : trafficSource
          ? { text: trafficSource, variant: 'default' }
          : { text: '待接入', variant: 'default' },
    },
    {
      key: 'status',
      label: '设备状态',
      valueNode: (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <div className="inline-flex items-center gap-1.5">
            <Wifi className="h-3.5 w-3.5 text-green-600" />
            <span className="text-sm font-semibold">{summary.onlineDevices}</span>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <WifiOff className="h-3.5 w-3.5 text-red-600" />
            <span className="text-sm font-semibold">{summary.offlineDevices}</span>
          </div>
        </div>
      ),
      icon: Cpu,
      iconBg: 'bg-violet-500/10',
      iconColor: 'text-violet-500',
      badge: { text: `总 ${summary.totalDevices}`, variant: 'default' },
    },
    {
      key: 'alarm',
      label: '报警数量',
      value: `${summary.alarmCount}`,
      icon: AlertTriangle,
      iconBg: 'bg-orange-500/10',
      iconColor: 'text-orange-500',
      badge: { text: '告警', variant: 'warning' },
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 lg:grid-cols-5">
      {stats.map((stat) => {
        const Icon = stat.icon;
        const card = (
          <Card key={stat.label} className="h-full">
            <CardContent className="h-full p-2.5">
              <div className="flex h-full items-center gap-2.5">
                <div className={cn('rounded-lg p-2 shrink-0', stat.iconBg)}>
                  <Icon className={cn('h-4 w-4', stat.iconColor)} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="min-w-0 truncate text-[11px] text-muted-foreground sm:text-xs">{stat.label}</p>
                    {stat.badge && (
                      <Badge variant={stat.badge.variant} className="shrink-0 whitespace-nowrap text-[10px] px-1.5 py-0">
                        {stat.badge.text}
                      </Badge>
                    )}
                  </div>
                  {stat.valueNode ? (
                    <div className="min-w-0 overflow-hidden">{stat.valueNode}</div>
                  ) : (
                    <div className="mt-1 truncate text-sm font-bold sm:text-lg">{stat.value}</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );

        if (stat.key === 'cost') {
          return (
            <FeeHint key={stat.label} pricePerKwh={pricePerKwh}>
              <div className="cursor-help">{card}</div>
            </FeeHint>
          );
        }

        return card;
      })}
    </div>
  );
}

export default StatsCards;
