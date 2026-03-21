import type { Portfolio } from "../types/portfolio";

type Props = {
  portfolios: Portfolio[];
  activeId: string;
  onChange: (id: string) => void;
};

function PortfolioTabs({ portfolios, activeId, onChange }: Props) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {portfolios.map((portfolio) => {
        const active = portfolio.id === activeId;
        return (
          <button
            key={portfolio.id}
            type="button"
            onClick={() => onChange(portfolio.id)}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition ${
              active
                ? "border-brand-500 bg-brand-500 text-white shadow-glow"
                : "border-white/70 bg-white/80 text-slate-700 hover:border-brand-300 hover:text-brand-700"
            }`}
          >
            {portfolio.name}
          </button>
        );
      })}
    </div>
  );
}

export default PortfolioTabs;
