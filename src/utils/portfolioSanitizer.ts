import type { Portfolio } from "../types/portfolio";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeNonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function sanitizeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function sanitizePortfolioId(value: unknown, fallback: string): string {
  const base = sanitizeString(value, fallback)
    .replace(/\s+/g, "_")
    .replace(/[^\w가-힣-]/g, "");
  return base || fallback;
}

function sanitizeLoadedPortfolio(raw: unknown, pIndex: number): Portfolio | null {
  if (!isRecord(raw)) return null;

  const fallbackId = `loaded_${Date.now()}_${pIndex + 1}`;
  const id = sanitizePortfolioId(raw.id, fallbackId);
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (rawItems.length === 0) return null;

  const items = rawItems
    .map((item, iIndex) => {
      if (!isRecord(item)) return null;
      const category = item.category === "안전자산" ? "안전자산" : "위험자산";
      const code = sanitizeString(item.code).replace(/[^\w-]/g, "");
      return {
        id: sanitizePortfolioId(item.id, `${id}_item_${iIndex + 1}`),
        category,
        subCategory: sanitizeString(item.subCategory, "기타"),
        dividendYield: sanitizeNonNegativeNumber(item.dividendYield, 0),
        name: sanitizeString(item.name, `종목_${iIndex + 1}`),
        code: code || `CODE_${iIndex + 1}`,
        price: sanitizeNonNegativeNumber(item.price, 0),
        weight: sanitizeNonNegativeNumber(item.weight, 0),
      };
    })
    .filter((item): item is Portfolio["items"][number] => item !== null);

  if (items.length === 0) return null;

  const kpiRaw = isRecord(raw.kpi) ? raw.kpi : {};
  const principalLabel = raw.principalLabel === "원금" ? "원금" : "투자금";

  return {
    id,
    name: sanitizeString(raw.name, `불러온 포트폴리오 ${pIndex + 1}`),
    principalLabel,
    principal: sanitizeNonNegativeNumber(raw.principal, 0),
    items,
    kpi: {
      cagr: sanitizeNonNegativeNumber(kpiRaw.cagr, 0),
      mdd: sanitizeNonNegativeNumber(kpiRaw.mdd, 0),
      sharpe: sanitizeNonNegativeNumber(kpiRaw.sharpe, 0),
      annualDividendYield: sanitizeNonNegativeNumber(kpiRaw.annualDividendYield, 0),
    },
    isCustom: typeof raw.isCustom === "boolean" ? raw.isCustom : true,
  };
}

function ensureUniquePortfolioIds(portfolios: Portfolio[]): Portfolio[] {
  const used = new Set<string>();
  return portfolios.map((portfolio, pIndex) => {
    const base = sanitizePortfolioId(portfolio.id, `loaded_${pIndex + 1}`);
    let nextId = base;
    let suffix = 2;
    while (used.has(nextId)) {
      nextId = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(nextId);
    return {
      ...portfolio,
      id: nextId,
      items: portfolio.items.map((item, iIndex) => ({
        ...item,
        id: sanitizePortfolioId(item.id, `${nextId}_item_${iIndex + 1}`),
      })),
    };
  });
}

export function sanitizePortfoliosFromUnknown(input: unknown): Portfolio[] {
  if (!Array.isArray(input) || input.length === 0) return [];
  return ensureUniquePortfolioIds(
    input
      .map((portfolio, index) => sanitizeLoadedPortfolio(portfolio, index))
      .filter((portfolio): portfolio is Portfolio => portfolio !== null)
  );
}

