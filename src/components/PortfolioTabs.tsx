import type { Portfolio } from "../types/portfolio";

type Props = {
  portfolios: Portfolio[];
  activeId: string;
  onChange: (id: string) => void;
};

function PortfolioTabs({ portfolios, activeId, onChange }: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
      {portfolios.map((portfolio) => {
        const active = portfolio.id === activeId;
        return (
          <button
            key={portfolio.id}
            type="button"
            onClick={() => onChange(portfolio.id)}
            className={`w-full rounded-full border px-3 py-2.5 text-sm font-semibold transition lg:w-auto lg:px-4 ${
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
