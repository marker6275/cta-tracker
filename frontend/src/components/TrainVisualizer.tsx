"use client";

type LineStats = {
  line: string;
  color: string;
  activeTrains: number;
  recentArrivals: number;
};

type TrainVisualizerProps = {
  stats: LineStats[];
};

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.substring(0, 2), 16);
  const g = Number.parseInt(value.substring(2, 4), 16);
  const b = Number.parseInt(value.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function TrainVisualizer({ stats }: TrainVisualizerProps) {
  return (
    <div className="absolute bottom-4 left-4 right-4 rounded-lg bg-slate-900/80 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-200">
        <span className="font-medium">Train Visualizer</span>
        <span className="text-slate-400">bars combine live trains + arrivals</span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {stats.map((item) => {
          const height = Math.min(100, item.activeTrains * 14 + item.recentArrivals * 28 + 8);
          return (
            <div key={item.line} className="rounded border border-slate-700/70 bg-slate-800/70 p-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-100">{item.line}</span>
                <span className="text-slate-300">{item.activeTrains}</span>
              </div>
              <div className="h-16 rounded bg-slate-900 p-1">
                <div
                  className="h-full rounded transition-all duration-500"
                  style={{
                    height: `${height}%`,
                    backgroundColor: hexToRgba(item.color, 0.95),
                    boxShadow: `0 0 14px ${hexToRgba(item.color, 0.6)}`,
                  }}
                />
              </div>
              <div className="mt-1 text-[11px] text-slate-300">arrivals: {item.recentArrivals}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
