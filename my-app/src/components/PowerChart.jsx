// src/components/PowerChart.jsx
import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  TimeScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
import 'chartjs-adapter-date-fns';

ChartJS.register(
  CategoryScale,
  TimeScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

export default function PowerChart({ points }) {
  // points = [{ ts_ms, value }]
  const data = useMemo(() => {
    const labels = points.map(p => new Date(p.ts_ms));
    const values = points.map(p => p.value);
    return {
      labels,
      datasets: [
        {
          label: 'Power (W)',
          data: values,
          borderColor: '#78c6a3',
          backgroundColor: 'rgba(255,182,193,0.18)',
          pointBorderColor: '#ff9eb5',
          pointBackgroundColor: '#ffe5ec',
          borderWidth: 3,
          tension: 0.35,
          pointRadius: 3
        }
      ]
    };
  }, [points]);

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: '#444' } },
      title: { display: false }
    },
    scales: {
      x: {
        type: 'time',
        time: { unit: 'hour', tooltipFormat: 'PPpp' },
        ticks: { color: '#666' },
        grid: { color: 'rgba(0,0,0,0.04)' }
      },
      y: {
        ticks: { color: '#666' },
        grid: { color: 'rgba(0,0,0,0.04)' }
      }
    }
  }), []);

  return (
    <div style={{ height: 360 }}>
      <Line options={options} data={data} />
    </div>
  );
}
