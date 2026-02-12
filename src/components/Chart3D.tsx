"use client";

import dynamic from "next/dynamic";

const ApexChart = dynamic(() => import("react-apexcharts"), {
  ssr: false,
});

type Chart3DProps = {
  title: string;
  data: Array<{ x: number; y: number; z: number; label?: string }>;
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
};

export default function Chart3D({
  title,
  data,
  xLabel = "X",
  yLabel = "Y",
  zLabel = "Z",
}: Chart3DProps) {
  if (!data || data.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <p className="mt-2 text-xs text-slate-500">Žádná data pro 3D graf.</p>
      </div>
    );
  }

  // Transform data for bubble chart (simulating 3D with bubble size)
  const series = [
    {
      name: zLabel,
      data: data.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z, // bubble size represents Z axis
      })),
    },
  ];

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      <p className="mt-1 text-[10px] text-slate-400">
        Vizualizace 3D: velikost bubliny = {zLabel}
      </p>
      <div className="mt-4">
        <ApexChart
          type="bubble"
          height={400}
          series={series}
          options={{
            chart: {
              toolbar: {
                show: true,
                tools: {
                  download: true,
                  zoom: true,
                  zoomin: true,
                  zoomout: true,
                  pan: true,
                  reset: true,
                },
              },
              zoom: {
                enabled: true,
              },
            },
            dataLabels: {
              enabled: false,
            },
            xaxis: {
              title: { text: xLabel },
              tickAmount: 10,
              type: "numeric",
            },
            yaxis: {
              title: { text: yLabel },
              tickAmount: 10,
            },
            legend: {
              position: "top",
            },
            theme: {
              mode: "dark",
            },
            tooltip: {
              custom: ({ seriesIndex, dataPointIndex, w }) => {
                const point = data[dataPointIndex];
                return `<div class="px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs">
                  ${point.label ? `<div class="font-semibold text-slate-100 mb-1">${point.label}</div>` : ""}
                  <div class="text-slate-300">${xLabel}: ${point.x}</div>
                  <div class="text-slate-300">${yLabel}: ${point.y}</div>
                  <div class="text-slate-300">${zLabel}: ${point.z}</div>
                </div>`;
              },
            },
          }}
        />
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        <p>💡 Tip: Použijte toolbar pro zoom a pan. Velikost bubliny reprezentuje třetí rozměr.</p>
      </div>
    </div>
  );
}
