import { useState } from "react";

type Props = {
  onCreate: (name: string, principalLabel: "투자금" | "원금", principal: number) => void;
};

function CustomPortfolioForm({ onCreate }: Props) {
  const [name, setName] = useState("");
  const [principalLabel, setPrincipalLabel] = useState<"투자금" | "원금">("투자금");
  const [principal, setPrincipal] = useState(300000000);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, principalLabel, principal);
    setName("");
  };

  return (
    <div className="rounded-2xl border border-fuchsia-200/80 bg-white/80 p-3">
      <p className="text-xs font-bold text-fuchsia-700">사용자 정의 포트폴리오 추가</p>
      <div className="mt-2 grid gap-2 md:grid-cols-[1fr_110px_160px_110px]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: F형_내전략"
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
        />
        <select
          value={principalLabel}
          onChange={(e) => setPrincipalLabel(e.target.value as "투자금" | "원금")}
          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm"
        >
          <option value="투자금">투자금</option>
          <option value="원금">원금</option>
        </select>
        <input
          inputMode="decimal"
          value={principal}
          onChange={(e) => setPrincipal(Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-right text-sm"
        />
        <button
          type="button"
          onClick={handleSubmit}
          className="rounded-lg border border-fuchsia-300 bg-fuchsia-100 px-3 py-2 text-sm font-semibold text-fuchsia-700 hover:bg-fuchsia-200"
        >
          추가
        </button>
      </div>
    </div>
  );
}

export default CustomPortfolioForm;
