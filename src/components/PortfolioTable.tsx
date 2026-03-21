import { type KeyboardEvent, useState } from "react";
import { calcCheckAmount, calcShareCount } from "../utils/calculations";
import { formatCurrencyKRW, formatNumber, formatPercent } from "../utils/formatters";
import type { AssetItem } from "../types/portfolio";

type Props = {
  principal: number;
  items: AssetItem[];
  integerShareMode: boolean;
  priceDate?: string | null;
  onUpdateItem: (
    itemId: string,
    field: "price" | "weight" | "dividendYield",
    value: number
  ) => void;
};

function numberOnly(value: string): number {
  return Number(value.replace(/[^0-9.]/g, "")) || 0;
}

function handleEnterMove(
  e: KeyboardEvent<HTMLInputElement>,
  currentIndex: number,
  totalInputs: number
): void {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const nextIndex = (currentIndex + 1) % totalInputs;
  const next = document.querySelector<HTMLInputElement>(
    `[data-nav-index="${nextIndex}"]`
  );
  next?.focus();
  next?.select();
}

function PortfolioTable({ principal, items, integerShareMode, priceDate, onUpdateItem }: Props) {
  const [focusedPriceKey, setFocusedPriceKey] = useState<string | null>(null);
  const totalCheck = items.reduce((sum, item) => {
    const qty = calcShareCount(principal, item.weight, item.price, {
      integerMode: integerShareMode,
      precision: 4,
    });
    return sum + calcCheckAmount(item.price, qty);
  }, 0);
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const totalEditableInputs = items.length * 3;

  return (
    <div className="overflow-hidden rounded-2xl border border-white/70 bg-white/85 shadow-sm">
      {/* ── 모바일: 종목별 카드 뷰 ── */}
      <div className="md:hidden">
        <div className="space-y-3 p-3">
          {priceDate && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-center text-xs font-semibold text-slate-600">
              📅 현재가격 기준: {priceDate}
            </p>
          )}
          {items.map((item) => {
            const mPriceKey = `${item.id}_m`;
            const mPriceFocused = focusedPriceKey === mPriceKey;
            const qty = calcShareCount(principal, item.weight, item.price, {
              integerMode: integerShareMode,
              precision: 4,
            });
            const check = calcCheckAmount(item.price, qty);
            const invalidPrice = item.price <= 0;
            const isSafe = item.category === "안전자산";

            return (
              <div
                key={item.id}
                className={`rounded-xl border p-3 ${
                  isSafe
                    ? "border-sky-100 bg-sky-50/70"
                    : "border-rose-100 bg-rose-50/60"
                }`}
              >
                {/* 종목 정보 + 매수 결과 */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[11px] font-bold ${
                          isSafe
                            ? "bg-sky-100 text-sky-700"
                            : "bg-rose-100 text-rose-700"
                        }`}
                      >
                        {item.category}
                      </span>
                      <span className="text-[11px] text-slate-400">{item.subCategory}</span>
                    </div>
                    <p className="mt-1 truncate text-sm font-semibold text-slate-900">{item.name}</p>
                    <p className="text-xs text-slate-400">{item.code}</p>
                  </div>
                  {/* 핵심 결과: 매수 주식수 + 투자금액 */}
                  <div className="shrink-0 text-left sm:text-right">
                    <p className="text-xl font-black text-slate-800">
                      {formatNumber(qty)}
                      <span className="ml-0.5 text-sm font-semibold text-slate-500">주</span>
                    </p>
                    <p className="text-sm font-bold text-slate-600">{formatCurrencyKRW(check)}</p>
                  </div>
                </div>

                {/* 편집 입력창 */}
                <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">
                      배당(%)
                    </label>
                    <input
                      inputMode="decimal"
                      value={item.dividendYield}
                      onChange={(e) =>
                        onUpdateItem(item.id, "dividendYield", numberOnly(e.target.value))
                      }
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2.5 text-right text-sm sm:text-center"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">
                      현재가(원)
                    </label>
                    <input
                      inputMode="decimal"
                      value={
                        mPriceFocused
                          ? item.price === 0 ? "" : String(item.price)
                          : item.price.toLocaleString("ko-KR")
                      }
                      onChange={(e) =>
                        onUpdateItem(item.id, "price", numberOnly(e.target.value))
                      }
                      onFocus={(e) => {
                        setFocusedPriceKey(mPriceKey);
                        e.currentTarget.select();
                      }}
                      onBlur={() => setFocusedPriceKey(null)}
                      className={`w-full rounded-lg border px-2.5 py-2.5 text-right text-sm sm:text-center ${
                        invalidPrice
                          ? "border-rose-500 bg-rose-50"
                          : "border-slate-200 bg-white"
                      }`}
                    />
                    {invalidPrice && (
                      <p className="mt-0.5 text-[11px] text-rose-600">0보다 커야 합니다</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-500">
                      비중(%)
                    </label>
                    <input
                      inputMode="decimal"
                      value={item.weight}
                      onChange={(e) =>
                        onUpdateItem(item.id, "weight", numberOnly(e.target.value))
                      }
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2.5 text-right text-sm sm:text-center"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 모바일 합계 푸터 */}
        <div className="mx-3 mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-900 px-4 py-3 text-white">
          <div>
            <p className="text-[11px] text-slate-400">비중 합계</p>
            <p className="text-base font-bold">{formatPercent(totalWeight)}</p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">투자금액 합계</p>
            <p className="text-base font-bold">{formatCurrencyKRW(totalCheck)}</p>
          </div>
        </div>
      </div>

      {/* ── 데스크톱: 기존 테이블 뷰 ── */}
      <div className="hidden md:block">
        <div className="max-h-[58vh] overflow-auto">
          <table className="min-w-[1100px] w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-gradient-to-r from-orange-100 to-amber-100 text-xs text-slate-700">
              <tr>
                <th className="px-3 py-3 text-left font-bold">분류</th>
                <th className="px-3 py-3 text-left font-bold">구분</th>
                <th className="px-3 py-3 text-right font-bold">1년배당(%)</th>
                <th className="px-3 py-3 text-left font-bold">종목명</th>
                <th className="px-3 py-3 text-left font-bold">코드</th>
                <th className="px-3 py-3 text-right font-bold">
                  <span className="block">현재가격(1주)</span>
                  {priceDate && (
                    <span className="block text-[9px] font-normal text-slate-500">
                      {priceDate} 기준
                    </span>
                  )}
                </th>
                <th className="px-3 py-3 text-right font-bold">비중(%)</th>
                <th className="px-3 py-3 text-right font-bold">주식수</th>
                <th className="px-3 py-3 text-right font-bold">투자금액</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, rowIndex) => {
                const rowBaseIndex = rowIndex * 3;
                const qty = calcShareCount(principal, item.weight, item.price, {
                  integerMode: integerShareMode,
                  precision: 4,
                });
                const check = calcCheckAmount(item.price, qty);
                const invalidPrice = item.price <= 0;
                const rowTone =
                  item.category === "안전자산"
                    ? "bg-sky-50/65 hover:bg-sky-100/65"
                    : "bg-rose-50/60 hover:bg-rose-100/60";

                return (
                  <tr key={item.id} className={`border-b border-slate-100 transition ${rowTone}`}>
                    <td className="px-3 py-3 text-sm font-semibold text-slate-700">{item.category}</td>
                    <td className="px-3 py-3 text-sm text-slate-700">{item.subCategory}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        inputMode="decimal"
                        value={item.dividendYield}
                        onChange={(e) =>
                          onUpdateItem(item.id, "dividendYield", numberOnly(e.target.value))
                        }
                        data-nav-index={rowBaseIndex}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) =>
                          handleEnterMove(e, rowBaseIndex, totalEditableInputs)
                        }
                        className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-sm"
                      />
                    </td>
                    <td className="px-3 py-3 text-sm font-medium text-slate-900">{item.name}</td>
                    <td className="px-3 py-3 text-xs text-slate-500">{item.code}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        inputMode="decimal"
                        value={(() => {
                          const dKey = `${item.id}_d`;
                          return focusedPriceKey === dKey
                            ? item.price === 0 ? "" : String(item.price)
                            : item.price.toLocaleString("ko-KR");
                        })()}
                        onChange={(e) =>
                          onUpdateItem(item.id, "price", numberOnly(e.target.value))
                        }
                        data-nav-index={rowBaseIndex + 1}
                        onFocus={(e) => {
                          setFocusedPriceKey(`${item.id}_d`);
                          e.currentTarget.select();
                        }}
                        onBlur={() => setFocusedPriceKey(null)}
                        onKeyDown={(e) =>
                          handleEnterMove(e, rowBaseIndex + 1, totalEditableInputs)
                        }
                        className={`w-28 rounded-lg border px-2 py-1 text-right text-sm ${
                          invalidPrice ? "border-rose-500 bg-rose-50" : "border-slate-200 bg-white"
                        }`}
                      />
                      {invalidPrice && (
                        <p className="mt-1 text-[10px] text-rose-600">0보다 커야 합니다</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        inputMode="decimal"
                        value={item.weight}
                        onChange={(e) =>
                          onUpdateItem(item.id, "weight", numberOnly(e.target.value))
                        }
                        data-nav-index={rowBaseIndex + 2}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) =>
                          handleEnterMove(e, rowBaseIndex + 2, totalEditableInputs)
                        }
                        className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-right text-sm"
                      />
                    </td>
                    <td className="px-3 py-3 text-right text-sm font-semibold text-slate-700">
                      {formatNumber(qty)}
                    </td>
                    <td className="px-3 py-3 text-right text-sm font-semibold text-slate-800">
                      {formatCurrencyKRW(check)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0 bg-slate-900 text-white">
              <tr>
                <td className="px-3 py-3 text-sm font-bold" colSpan={6}>
                  합계
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold">
                  {formatPercent(totalWeight)}
                </td>
                <td className="px-3 py-3 text-right text-sm font-bold">-</td>
                <td className="px-3 py-3 text-right text-sm font-bold">
                  {formatCurrencyKRW(totalCheck)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

export default PortfolioTable;
