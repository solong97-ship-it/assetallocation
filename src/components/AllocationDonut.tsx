import { formatPercent } from "../utils/formatters";

type Props = {
  safeWeight: number;
  riskyWeight: number;
};

function AllocationDonut({ safeWeight, riskyWeight }: Props) {
  const totalWeight = safeWeight + riskyWeight;
  const safeShare = totalWeight > 0 ? safeWeight / totalWeight : 0;
  const safeDeg = safeShare * 360;
  const totalIsOk = Math.abs(totalWeight - 100) < 0.01;

  return (
    <div className="rounded-2xl border border-white/60 bg-white/85 p-4 shadow-sm">
      <p className="text-sm font-semibold text-slate-600">자산 배분</p>
      <div className="mt-3 flex items-center gap-5">
        <div
          className="relative h-28 w-28 shrink-0 rounded-full"
          style={{
            background: `conic-gradient(#38bdf8 0deg ${safeDeg}deg, #fb7185 ${safeDeg}deg 360deg)`,
          }}
        >
          <div className="absolute inset-0 m-5 flex flex-col items-center justify-center rounded-full bg-white text-center">
            <span className="text-[10px] font-medium text-slate-400">합계</span>
            <span
              className={`text-xs font-black ${totalIsOk ? "text-emerald-600" : "text-rose-600"}`}
            >
              {formatPercent(totalWeight)}
            </span>
          </div>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <p className="text-[10px] font-medium text-slate-400">안전자산</p>
            <p className="text-lg font-bold text-sky-600">{formatPercent(safeWeight)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-slate-400">위험자산</p>
            <p className="text-lg font-bold text-rose-500">{formatPercent(riskyWeight)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AllocationDonut;
