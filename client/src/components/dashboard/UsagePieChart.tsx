import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { RealtimeEnergyData } from '../../types';
import { formatValueUnitHtml } from '../ui/value-with-unit';

interface UsagePieChartProps {
  rooms: RealtimeEnergyData[];
}

const PIE_COLORS = [
  '#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#8b5cf6',
];

export function UsagePieChart({ rooms }: UsagePieChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const data = rooms
      .filter((r) => r.todayUsage > 0)
      .map((r) => ({
        name: r.displayName || r.roomNumber,
        value: Number(r.todayUsage.toFixed(2)),
      }));

    if (data.length === 0) {
      return {
        title: {
          text: '暂无数据',
          left: 'center',
          top: 'center',
          textStyle: { color: '#9ca3af', fontSize: 14, fontWeight: 400 },
        },
      };
    }

    return {
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}<br/>用电量: ${formatValueUnitHtml(p.value, 'kWh')}<br/>占比: ${p.percent}%`;
        },
      },
      legend: {
        type: 'scroll',
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: { color: '#6b7280', fontSize: 11 },
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 8,
      },
      color: PIE_COLORS,
      series: [
        {
          name: '今日用电',
          type: 'pie',
          radius: ['45%', '72%'],
          center: ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: {
            borderRadius: 6,
            borderColor: '#ffffff',
            borderWidth: 2,
          },
          label: {
            show: false,
          },
          emphasis: {
            label: {
              show: true,
              fontSize: 13,
              fontWeight: 'bold',
              formatter: '{b}\n{d}%',
            },
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.15)',
            },
          },
          labelLine: {
            show: false,
          },
          data,
        },
      ],
    };
  }, [rooms]);

  return (
    <ReactECharts
      option={option}
      style={{ width: '100%', height: '100%' }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}

export default UsagePieChart;
