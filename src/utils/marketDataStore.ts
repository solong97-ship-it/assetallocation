import type { PricePoint } from "./priceFetcher";

export type StoredLatestQuote = {
  price: number;
  source: string;
  fetchedAt: string;
};

type StoredHistorySeries = {
  points: PricePoint[];
  updatedAt: string;
};

export type StoredDividendYield = {
  dividendYield: number;
  source: string;
  updatedAt: string;
};

type MarketDataStoreV1 = {
  version: 1;
  latestByCode: Record<string, StoredLatestQuote>;
  historyByCode: Record<string, StoredHistorySeries>;
  dividendYieldByCode: Record<string, StoredDividendYield>;
};

const STORAGE_KEY = "assetallocation.marketData.v1";
const MAX_HISTORY_POINTS_PER_CODE = 320;

let memoryStore: MarketDataStoreV1 | null = null;

function createEmptyStore(): MarketDataStoreV1 {
  return {
    version: 1,
    latestByCode: {},
    historyByCode: {},
    dividendYieldByCode: {},
  };
}

function isBrowserStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeHistoryPoints(points: PricePoint[]): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const point of points) {
    if (!point || typeof point.date !== "string" || !point.date) continue;
    const close = Number(point.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    byDate.set(point.date, close);
  }
  const normalized = [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (normalized.length <= MAX_HISTORY_POINTS_PER_CODE) return normalized;
  return normalized.slice(normalized.length - MAX_HISTORY_POINTS_PER_CODE);
}

function sanitizeLoadedStore(raw: unknown): MarketDataStoreV1 {
  if (!raw || typeof raw !== "object") return createEmptyStore();
  const parsed = raw as Partial<MarketDataStoreV1>;
  const next = createEmptyStore();

  if (parsed.latestByCode && typeof parsed.latestByCode === "object") {
    for (const [code, quote] of Object.entries(parsed.latestByCode)) {
      if (!quote || typeof quote !== "object") continue;
      const q = quote as Partial<StoredLatestQuote>;
      const price = Number(q.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      next.latestByCode[code] = {
        price,
        source: String(q.source ?? "cache"),
        fetchedAt: String(q.fetchedAt ?? new Date(0).toISOString()),
      };
    }
  }

  if (parsed.historyByCode && typeof parsed.historyByCode === "object") {
    for (const [code, series] of Object.entries(parsed.historyByCode)) {
      if (!series || typeof series !== "object") continue;
      const s = series as Partial<StoredHistorySeries>;
      const points = normalizeHistoryPoints(Array.isArray(s.points) ? (s.points as PricePoint[]) : []);
      if (points.length === 0) continue;
      next.historyByCode[code] = {
        points,
        updatedAt: String(s.updatedAt ?? new Date(0).toISOString()),
      };
    }
  }

  if (parsed.dividendYieldByCode && typeof parsed.dividendYieldByCode === "object") {
    for (const [code, dividendInfo] of Object.entries(parsed.dividendYieldByCode)) {
      if (!dividendInfo || typeof dividendInfo !== "object") continue;
      const entry = dividendInfo as Partial<StoredDividendYield>;
      const dividendYield = Number(entry.dividendYield);
      if (!Number.isFinite(dividendYield) || dividendYield < 0) continue;
      next.dividendYieldByCode[code] = {
        dividendYield,
        source: String(entry.source ?? "unknown"),
        updatedAt: String(entry.updatedAt ?? new Date(0).toISOString()),
      };
    }
  }

  return next;
}

function loadStore(): MarketDataStoreV1 {
  if (memoryStore) return memoryStore;
  if (!isBrowserStorageAvailable()) {
    memoryStore = createEmptyStore();
    return memoryStore;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memoryStore = createEmptyStore();
      return memoryStore;
    }
    memoryStore = sanitizeLoadedStore(JSON.parse(raw));
    return memoryStore;
  } catch {
    memoryStore = createEmptyStore();
    return memoryStore;
  }
}

function persistStore(store: MarketDataStoreV1): void {
  memoryStore = store;
  if (!isBrowserStorageAvailable()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota/storage errors
  }
}

export function getStoredLatestQuotesByCodes(codes: string[]): Record<string, StoredLatestQuote> {
  const store = loadStore();
  const result: Record<string, StoredLatestQuote> = {};
  for (const code of codes) {
    const quote = store.latestByCode[code];
    if (!quote) continue;
    result[code] = quote;
  }
  return result;
}

export function isStoredLatestQuoteFresh(
  quote: StoredLatestQuote | undefined,
  maxAgeMs: number
): boolean {
  if (!quote) return false;
  const ts = Date.parse(quote.fetchedAt);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= maxAgeMs;
}

export function upsertStoredLatestQuotes(
  pricesByCode: Record<string, number>,
  sourceByCode: Record<string, string>
): void {
  const store = loadStore();
  const nowIso = new Date().toISOString();
  for (const [code, rawPrice] of Object.entries(pricesByCode)) {
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    store.latestByCode[code] = {
      price,
      source: sourceByCode[code] ?? "unknown",
      fetchedAt: nowIso,
    };
  }
  persistStore(store);
}

export function getStoredHistoriesByCodes(codes: string[]): Record<string, PricePoint[]> {
  const store = loadStore();
  const result: Record<string, PricePoint[]> = {};
  for (const code of codes) {
    const series = store.historyByCode[code];
    if (!series || series.points.length === 0) continue;
    result[code] = [...series.points];
  }
  return result;
}

export function upsertStoredHistories(historyByCode: Record<string, PricePoint[]>): void {
  const store = loadStore();
  const nowIso = new Date().toISOString();

  for (const [code, incoming] of Object.entries(historyByCode)) {
    const existing = store.historyByCode[code]?.points ?? [];
    const merged = normalizeHistoryPoints([...existing, ...incoming]);
    if (merged.length === 0) continue;
    store.historyByCode[code] = {
      points: merged,
      updatedAt: nowIso,
    };
  }

  persistStore(store);
}

export function isStoredHistoryFresh(points: PricePoint[] | undefined, staleDays: number): boolean {
  if (!points || points.length < 30) return false;
  const latestDate = points[points.length - 1]?.date;
  if (!latestDate) return false;
  const latest = new Date(`${latestDate}T00:00:00Z`);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(latest.getTime()) || !Number.isFinite(today.getTime())) return false;
  const diffDays = Math.floor((today.getTime() - latest.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays <= staleDays;
}

export function getStoredDividendYieldsByCodes(
  codes: string[]
): Record<string, StoredDividendYield> {
  const store = loadStore();
  const result: Record<string, StoredDividendYield> = {};
  for (const code of codes) {
    const dividend = store.dividendYieldByCode[code];
    if (!dividend) continue;
    result[code] = dividend;
  }
  return result;
}

export function isStoredDividendYieldFresh(
  dividend: StoredDividendYield | undefined,
  staleDays: number
): boolean {
  if (!dividend) return false;
  const ts = Date.parse(dividend.updatedAt);
  if (!Number.isFinite(ts)) return false;
  const diffDays = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  return diffDays <= staleDays;
}

export function upsertStoredDividendYields(
  dividendYieldByCode: Record<string, number>,
  sourceByCode: Record<string, string>
): void {
  const store = loadStore();
  const nowIso = new Date().toISOString();
  for (const [code, rawDividendYield] of Object.entries(dividendYieldByCode)) {
    const dividendYield = Number(rawDividendYield);
    if (!Number.isFinite(dividendYield) || dividendYield < 0) continue;
    store.dividendYieldByCode[code] = {
      dividendYield,
      source: sourceByCode[code] ?? "unknown",
      updatedAt: nowIso,
    };
  }
  persistStore(store);
}
