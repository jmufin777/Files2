"use client";

import dynamic from "next/dynamic";

const ApexChart = dynamic(() => import("react-apexcharts"), {
  ssr: false,
});

export type ChartType2D = "pie" | "bar" | "line";

type ResultsChartProps = {
  title: string;
  labels: string[];
  series: number[];
  chartType: ChartType2D;
};

export default function ResultsChart({
  title,
  labels,
  series,
  chartType,
}: ResultsChartProps) {
  if (labels.length === 0 || series.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <p className="mt-2 text-xs text-slate-500">Žádná data pro graf.</p>
      </div>
    );
  }

  if (chartType === "pie") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <div className="mt-4">
          <ApexChart
            type="pie"
            height={320}
            series={series}
            options={{
              labels,
              legend: { position: "bottom" },
              theme: { mode: "dark" },
            }}
          />
        </div>
      </div>
    );
  }

  if (chartType === "line") {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <div className="mt-4">
          <ApexChart
            type="line"
            height={320}
            series={[{ name: "Hodnota", data: series }]}
            options={{
              xaxis: { categories: labels },
              stroke: { curve: "smooth", width: 3 },
              markers: { size: 0 },
              legend: { position: "bottom" },
              theme: { mode: "dark" },
              tooltip: { shared: true },
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      <div className="mt-4">
        <ApexChart
          type="bar"
          height={320}
          series={[{ name: "Soubory", data: series }]}
          options={{
            xaxis: { categories: labels },
            legend: { position: "bottom" },
            theme: { mode: "dark" },
          }}
        />
      </div>
    </div>
  );
}
