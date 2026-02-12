'use client';

import React, { Suspense } from 'react';
import dynamic from 'next/dynamic';

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false });

interface Point3D {
  x: number;
  y: number;
  z: number;
  label?: string;
  size?: number;
  color?: string;
}

interface Plot3DProps {
  title?: string;
  data: Point3D[];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
  height?: number;
}

export default function Plot3D({
  title = '3D Scatter Plot',
  data,
  xLabel = 'X',
  yLabel = 'Y',
  zLabel = 'Z',
  height = 600,
}: Plot3DProps) {
  if (!data || data.length === 0) {
    return (
      <div className="w-full h-96 flex items-center justify-center rounded-lg border border-slate-300 bg-slate-50">
        <p className="text-slate-500">Žádná data pro zobrazení.</p>
      </div>
    );
  }

  // Prepare trace for 3D scatter
  const trace: any = {
    x: data.map(d => d.x),
    y: data.map(d => d.y),
    z: data.map(d => d.z),
    mode: 'markers',
    type: 'scatter3d',
    text: data.map((d, i) => d.label || `Bod ${i + 1}`),
    hovertemplate: `%{text}<br>${xLabel}: %{x}<br>${yLabel}: %{y}<br>${zLabel}: %{z}<extra></extra>`,
    marker: {
      size: data.map(d => d.size || 8),
      color: data.map(d => d.color || '#3b82f6'),
      opacity: 0.8,
      line: {
        width: 0.5,
        color: '#1e293b',
      },
    },
  };

  const layout: any = {
    title: { text: title },
    autosize: true,
    height: height,
    font: {
      size: 12,
      color: '#334155',
    },
    paper_bgcolor: '#f1f5f9',
    plot_bgcolor: '#ffffff',
    margin: {
      l: 0,
      r: 0,
      b: 0,
      t: 40,
    },
    scene: {
      xaxis: {
        title: xLabel,
        backgroundcolor: '#e2e8f0',
        gridcolor: '#cbd5e1',
        showbackground: true,
      },
      yaxis: {
        title: yLabel,
        backgroundcolor: '#e2e8f0',
        gridcolor: '#cbd5e1',
        showbackground: true,
      },
      zaxis: {
        title: zLabel,
        backgroundcolor: '#e2e8f0',
        gridcolor: '#cbd5e1',
        showbackground: true,
      },
      camera: {
        eye: { x: 1.5, y: 1.5, z: 1.5 },
      },
    },
  };

  const config: any = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
  };

  return (
    <div className="w-full rounded-lg border border-slate-300 bg-white overflow-hidden shadow-sm">
      <Suspense fallback={
        <div className="w-full h-96 flex items-center justify-center bg-slate-50">
          <p className="text-slate-500">Načítám graf...</p>
        </div>
      }>
        <Plot
          data={[trace]}
          layout={layout}
          config={config}
        />
      </Suspense>
    </div>
  );
}
