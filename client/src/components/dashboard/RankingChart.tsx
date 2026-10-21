import { useMemo } from 'react';
import EChartsBar from '../charts/EChartsBar';
import type { EChartsOption } from 'echarts';
import type { RankingItem } from '../../types';
import { formatValueUnitHtml } from '../ui/value-with-unit';

interface RankingChartProps {
  ranking: RankingItem[];
}

export function RankingChart({ ranking }: RankingChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const sorted = [...ranking].sort((a, b) => b.usage - a.usage).slice(0, 14);
    const reversed = [...sorted].reverse();
    const yData = reversed.map((r) => r.displayName || r.roomNumber);
    const xData = reversed.map((r) => Number(r.usage.toFixed(2)));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (params as Array<{ name: string; value: number }>)[0];
          return `${p.name}<br/>用电量: ${formatValueUnitHtml(p.value, 'kWh')}`;
        },
      },
      grid: {
        left: 50,
        right: 20,
        top: 10,
        bottom: 30,
      },
      xAxis: {
        type: 'value',
        name: 'kWh',
        nameTextStyle: { color: '#9ca3af', fontSize: 11 },
        axisLine: { lineStyle: { color: '#e5e7eb' } },
        axisLabel: { color: '#6b7280', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f3f4f6', type: 'dashed' } },
      },
      yAxis: {
        type: 'category',
        data: yData,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#374151',
          fontSize: 12,
          fontWeight: 500,
        },
      },
      series: [
        {
          type: 'bar',
          data: xData,
          barWidth: 16,
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 1,
              y2: 0,
              colorStops: [
                { offset: 0, color: '#6366f1' },
                { offset: 1, color: '#a855f7' },
              ],
            },
          },
          emphasis: {
            itemStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 1,
                y2: 0,
                colorStops: [
                  { offset: 0, color: '#4f46e5' },
                  { offset: 1, color: '#9333ea' },
                ],
              },
            },
          },
          label: {
            show: true,
            position: 'right',
            color: '#6b7280',
            fontSize: 11,
            formatter: '{c}',
          },
        },
      ],
    };
  }, [ranking]);

  return <EChartsBar option={option} style={{ width: '100%', height: '100%' }} />;
}

export default RankingChart;
