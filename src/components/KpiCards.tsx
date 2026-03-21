import { formatPercent } from "../utils/formatters";
import type { PortfolioKPI } from "../types/portfolio";

type Props = {
  kpi: PortfolioKPI;
  mode: "target" | "history";
  hasHistory: boolean;
  onModeChange: (mode: "target" | "history") => void;
};

function KpiCards({ kpi, mode, hasHistory, onModeChange }: Props) {
  const cards = [
    {
      label: "CAGR",
      value: formatPercent(kpi.cagr),
      desc: "연환산 복리 수익률",
      tone: "text-emerald-600",
    },
    {
      label: "MDD",
      value: formatPercent(kpi.mdd),
      desc: "최대 낙폭 (리스크)",
      tone: "text-rose-600",
    },
    {
      label: "Sharpe",
      value: kpi.sharpe.toFixed(2),
      desc: "위험 대비 수익성",
      tone: "text-sky-600",
    },
    {
      label: "연 배당수익률",
      value: formatPercent(kpi.annualDividendYield),
      desc: "보유 비중 가중 배당",
      tone: "text-violet-600",
    },
  ];

  return (
    <div className="space-y-2">
      {/* KPI 모드 선택 */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-500">
          {mode === "history" ? "KPI (과거 1년 실적)" : "KPI (목표값)"}
        </p>
        <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
          <button
            type="button"
            onClick={() => onModeChange("history")}
            className={`rounded-md px-2.5 py-1 transition ${
              mode === "history"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            과거 1년 분석
          </button>
          <button
            type="button"
            onClick={() => onModeChange("target")}
            className={`rounded-md px-2.5 py-1 transition ${
              mode === "target"
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            목표 KPI
          </button>
        </div>
      </div>

      {/* 실적 미로드 안내 */}
      {mode === "history" && !hasHistory && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
          ⚡ 시세·KPI 갱신 버튼을 눌러 실제 1년 분석값을 불러오세요. 현재는 목표값을 표시합니다.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="animate-fade-in rounded-2xl border border-white/60 bg-white/80 p-4 shadow-sm"
          >
            <p className="text-xs font-medium text-slate-500">{card.label}</p>
            <p className={`mt-1.5 text-xl font-extrabold ${card.tone}`}>{card.value}</p>
            <p className="mt-1 text-[10px] text-slate-400">{card.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default KpiCards;
