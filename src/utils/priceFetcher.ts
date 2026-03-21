type PriceFetchResult = {
  prices: Record<string, number>;
  sourceByCode: Record<string, string>;
  failedCodes: string[];
};

export type PricePoint = {
  date: string;
  close: number;
};

export type HistoryFetchResult = {
  historyByCode: Record<string, PricePoint[]>;
  failedCodes: string[];
};

export type DividendYieldFetchResult = {
  dividendYieldByCode: Record<string, number>;
  sourceByCode: Record<string, string>;
  failedCodes: string[];
};

export type PriceProgress = {
  done: number;
  total: number;
  code: string;
  successCount: number;
  failedCount: number;
  result: { price: number; source: string } | null;
};

export type HistoryProgress = {
  done: number;
  total: number;
  code: string;
  successCount: number;
  failedCount: number;
};

export type DividendYieldProgress = {
  done: number;
  total: number;
  code: string;
  successCount: number;
  failedCount: number;
  result: { dividendYield: number; source: string } | null;
};

export type HistoryFetchOptions = {
  existingHistoryByCode?: Record<string, PricePoint[]>;
  preferIncremental?: boolean;
  recentStaleDays?: number;
};

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number | null;
      };
      timestamp?: number[];
      events?: {
        dividends?: Record<
          string,
          {
            amount?: number | null;
            date?: number | null;
          }
        >;
      };
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: unknown;
  };
};

type JsonProxyTimeouts = {
  alloriginsRawMs: number;
  corsproxyMs: number;
  jinaMs: number;
};

const DEFAULT_PROXY_TIMEOUTS: JsonProxyTimeouts = {
  alloriginsRawMs: 15000,
  corsproxyMs: 15000,
  jinaMs: 18000,
};

const FAST_PROXY_TIMEOUTS: JsonProxyTimeouts = {
  alloriginsRawMs: 2800,
  corsproxyMs: 3200,
  jinaMs: 4500,
};

const PRICE_CACHE_TTL_MS = 20_000;
const DIVIDEND_YIELD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_FETCH_CONCURRENCY = 5;
const DIVIDEND_FETCH_CONCURRENCY = 4;
const HISTORY_MIN_POINTS = 30;
const HISTORY_TARGET_POINTS = 252;
const HISTORY_STALE_DAYS_DEFAULT = 4;

const latestPriceCache = new Map<
  string,
  { price: number; source: string; expiresAt: number }
>();
const dividendYieldCache = new Map<
  string,
  { dividendYield: number; source: string; expiresAt: number }
>();

function createTimeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

function extractJsonFromMaybeWrappedText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const marker = "Markdown Content:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex >= 0) {
    const after = trimmed.slice(markerIndex + marker.length).trim();
    const start = after.search(/[\[{]/);
    if (start >= 0) return after.slice(start).trim();
  }

  const fallbackStart = trimmed.search(/[\[{]/);
  if (fallbackStart >= 0) return trimmed.slice(fallbackStart).trim();
  throw new Error("json not found");
}

async function fetchJsonFromTextEndpoint<T>(
  url: string,
  timeoutMs: number
): Promise<T> {
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { signal: timeout.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const jsonText = extractJsonFromMaybeWrappedText(text);
    return JSON.parse(jsonText) as T;
  } finally {
    timeout.cleanup();
  }
}

async function fetchJsonViaProxyStrategies<T>(
  targetUrl: string,
  timeouts: JsonProxyTimeouts = DEFAULT_PROXY_TIMEOUTS
): Promise<T> {
  const strategies: Array<{ name: string; run: () => Promise<T> }> = [
    {
      name: "allorigins-raw",
      run: () =>
        fetchJsonFromTextEndpoint<T>(
          `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
          timeouts.alloriginsRawMs
        ),
    },
    {
      name: "corsproxy",
      run: () =>
        fetchJsonFromTextEndpoint<T>(
          `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
          timeouts.corsproxyMs
        ),
    },
    {
      name: "jina-ai",
      run: () =>
        fetchJsonFromTextEndpoint<T>(
          `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//, "")}`,
          timeouts.jinaMs
        ),
    },
  ];

  for (const strategy of strategies) {
    try {
      return await strategy.run();
    } catch {
      continue;
    }
  }
  throw new Error("all proxy strategies failed");
}

function parsePrice(value: unknown): number {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function getCachedLatestPrice(code: string): { price: number; source: string } | null {
  const cached = latestPriceCache.get(code);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    latestPriceCache.delete(code);
    return null;
  }
  return { price: cached.price, source: `${cached.source}(cache)` };
}

function setCachedLatestPrice(code: string, price: number, source: string): void {
  latestPriceCache.set(code, {
    price,
    source,
    expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
  });
}

function getCachedDividendYield(
  code: string
): { dividendYield: number; source: string } | null {
  const cached = dividendYieldCache.get(code);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    dividendYieldCache.delete(code);
    return null;
  }
  return { dividendYield: cached.dividendYield, source: `${cached.source}(cache)` };
}

function setCachedDividendYield(code: string, dividendYield: number, source: string): void {
  dividendYieldCache.set(code, {
    dividendYield,
    source,
    expiresAt: Date.now() + DIVIDEND_YIELD_CACHE_TTL_MS,
  });
}

async function firstSuccessful<T>(tasks: Array<() => Promise<T>>): Promise<T> {
  if (tasks.length === 0) throw new Error("no tasks");

  return new Promise<T>((resolve, reject) => {
    let rejectedCount = 0;

    tasks.forEach((task) => {
      task()
        .then((value) => {
          resolve(value);
        })
        .catch(() => {
          rejectedCount += 1;
          if (rejectedCount === tasks.length) reject(new Error("all tasks failed"));
        });
    });
  });
}

function normalizeKrxCode(code: string): string {
  const digits = String(code).replace(/\D/g, "");
  if (digits.length === 0) return String(code).trim();
  return digits.padStart(6, "0").slice(-6);
}

function getYahooSymbolsForKrx(code: string): string[] {
  const normalized = normalizeKrxCode(code);
  return [`${normalized}.KS`, `${normalized}.KQ`];
}

function findFirstPriceByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0
): number | null {
  if (depth > 8 || value == null) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstPriceByKeys(item, keys, depth + 1);
      if (found && found > 0) return found;
    }
    return null;
  }

  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const candidate = parsePrice(record[key]);
    if (candidate > 0) return candidate;
  }

  for (const nested of Object.values(record)) {
    const found = findFirstPriceByKeys(nested, keys, depth + 1);
    if (found && found > 0) return found;
  }

  return null;
}

function pickLastPositive(values: Array<number | null | undefined>): number {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const n = parsePrice(values[i]);
    if (n > 0) return n;
  }
  return 0;
}

function parseYahooCurrentPrice(payload: YahooChartResponse): number {
  const result = payload.chart?.result?.[0];
  if (!result) return 0;

  const marketPrice = parsePrice(result.meta?.regularMarketPrice);
  if (marketPrice > 0) return marketPrice;

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  return pickLastPositive(closes);
}

function parseYahooHistory(payload: YahooChartResponse): PricePoint[] {
  const result = payload.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const length = Math.min(timestamps.length, closes.length);
  const byDate = new Map<string, number>();

  for (let i = 0; i < length; i += 1) {
    const ts = timestamps[i];
    if (!Number.isFinite(ts)) continue;
    const close = parsePrice(closes[i]);
    if (close <= 0) continue;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    byDate.set(date, close);
  }

  return [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseYahooTrailingDividendYield(payload: YahooChartResponse): number | null {
  const result = payload.chart?.result?.[0];
  if (!result) return null;

  const marketPrice = parsePrice(result.meta?.regularMarketPrice);
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const closePrice = pickLastPositive(closes);
  const currentPrice = marketPrice > 0 ? marketPrice : closePrice;
  if (currentPrice <= 0) return null;

  const dividends = result.events?.dividends;
  if (!dividends || typeof dividends !== "object") return 0;

  let totalDividend = 0;
  for (const item of Object.values(dividends)) {
    const amount = Number(item?.amount ?? 0);
    if (Number.isFinite(amount) && amount > 0) totalDividend += amount;
  }

  if (totalDividend <= 0) return 0;
  return (totalDividend / currentPrice) * 100;
}

function normalizeHistoryPoints(points: PricePoint[]): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const point of points) {
    if (!point?.date) continue;
    const close = parsePrice(point.close);
    if (close <= 0) continue;
    byDate.set(point.date, close);
  }
  return [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mergeHistoryPoints(base: PricePoint[], incoming: PricePoint[]): PricePoint[] {
  return normalizeHistoryPoints([...base, ...incoming]);
}

function trimLatestHistoryPoints(points: PricePoint[], maxPoints = HISTORY_TARGET_POINTS): PricePoint[] {
  if (points.length <= maxPoints) return points;
  return points.slice(points.length - maxPoints);
}

function getLatestHistoryDate(points: PricePoint[]): string | null {
  if (points.length === 0) return null;
  return points[points.length - 1]?.date ?? null;
}

function calcDateDiffDays(laterDate: string, earlierDate: string): number {
  const later = new Date(`${laterDate}T00:00:00Z`);
  const earlier = new Date(`${earlierDate}T00:00:00Z`);
  if (!Number.isFinite(later.getTime()) || !Number.isFinite(earlier.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

function isHistoryRecent(points: PricePoint[], staleDays = HISTORY_STALE_DAYS_DEFAULT): boolean {
  if (points.length < HISTORY_MIN_POINTS) return false;
  const latest = getLatestHistoryDate(points);
  if (!latest) return false;
  const today = new Date().toISOString().slice(0, 10);
  return calcDateDiffDays(today, latest) <= staleDays;
}

async function fetchNaverPollingRealtimePrice(code: string): Promise<number> {
  const normalized = normalizeKrxCode(code);
  const targetUrl = `https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${normalized}`;
  const payload = await fetchJsonViaProxyStrategies<unknown>(targetUrl, FAST_PROXY_TIMEOUTS);
  const price = findFirstPriceByKeys(payload, [
    "nv",
    "closePrice",
    "stck_prpr",
    "marketPrice",
    "tradePrice",
    "price",
  ]);
  if (!price || price <= 0) throw new Error("invalid polling price");
  return price;
}

async function fetchYahooCurrentPrice(code: string): Promise<{ price: number; source: string } | null> {
  const symbols = getYahooSymbolsForKrx(code);
  for (const symbol of symbols) {
    try {
      const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const payload = await fetchJsonViaProxyStrategies<YahooChartResponse>(
        targetUrl,
        FAST_PROXY_TIMEOUTS
      );
      const price = parseYahooCurrentPrice(payload);
      if (price > 0) return { price, source: `yahoo:${symbol}` };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchNaverViaProxy(
  code: string,
  proxyType: "allorigins" | "corsproxy",
  timeoutMs = 5500
): Promise<number> {
  const naverUrl = `https://m.stock.naver.com/api/stock/${code}/basic`;
  let fetchUrl = "";
  let parseResponse: (res: Response) => Promise<Record<string, unknown>>;

  if (proxyType === "allorigins") {
    fetchUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(naverUrl)}`;
    parseResponse = async (res) => {
      const wrapper = (await res.json()) as { contents?: string };
      if (!wrapper.contents) throw new Error("empty contents");
      return JSON.parse(wrapper.contents) as Record<string, unknown>;
    };
  } else {
    fetchUrl = `https://corsproxy.io/?url=${encodeURIComponent(naverUrl)}`;
    parseResponse = async (res) => (await res.json()) as Record<string, unknown>;
  }

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(fetchUrl, { signal: timeout.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await parseResponse(res);
    const rawPrice = data.closePrice ?? data.now ?? data.marketPrice;
    const price = parsePrice(rawPrice);
    if (price <= 0) throw new Error("invalid price");
    return price;
  } finally {
    timeout.cleanup();
  }
}

async function fetchNaverHtmlScrape(code: string, timeoutMs = 6500): Promise<number> {
  const pageUrl = `https://finance.naver.com/item/main.naver?code=${code}`;
  const fetchUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`;
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(fetchUrl, { signal: timeout.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = (await res.json()) as { contents?: string };
    const html = wrapper.contents ?? "";
    const patterns = [
      /no_today">\s*<em[^>]*>\s*<span[^>]*>([\d,]+)<\/span>/,
      /today_summary.*?<strong[^>]*>([\d,]+)/s,
      /"now"[^>]*>([\d,]+)/,
      /class="no_today"[^>]*>[\s\S]*?([\d,]+)/,
      /blind">현재가<\/span>\s*([\d,]+)/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      const price = Number(match[1].replace(/,/g, ""));
      if (price > 0) return price;
    }
    throw new Error("price not found");
  } finally {
    timeout.cleanup();
  }
}

async function fetchSinglePrice(
  code: string
): Promise<{ price: number; source: string } | null> {
  const cached = getCachedLatestPrice(code);
  if (cached) return cached;

  try {
    const fast = await firstSuccessful<{ price: number; source: string }>([
      async () => ({
        price: await fetchNaverPollingRealtimePrice(code),
        source: "proxy+네이버Polling",
      }),
      async () => {
        const yahoo = await fetchYahooCurrentPrice(code);
        if (!yahoo) throw new Error("yahoo not found");
        return { price: yahoo.price, source: yahoo.source };
      },
    ]);
    if (fast.price > 0) {
      setCachedLatestPrice(code, fast.price, fast.source);
      return fast;
    }
  } catch {
    // fallthrough
  }

  try {
    const fallback = await firstSuccessful<{ price: number; source: string }>([
      async () => ({
        price: await fetchNaverViaProxy(code, "allorigins", 6000),
        source: "allorigins+네이버API",
      }),
      async () => ({
        price: await fetchNaverViaProxy(code, "corsproxy", 6000),
        source: "corsproxy+네이버API",
      }),
    ]);
    if (fallback.price > 0) {
      setCachedLatestPrice(code, fallback.price, fallback.source);
      return fallback;
    }
  } catch {
    // fallthrough
  }

  try {
    const htmlPrice = await fetchNaverHtmlScrape(code, 7000);
    if (htmlPrice > 0) {
      setCachedLatestPrice(code, htmlPrice, "allorigins+HTML스크래핑");
      return { price: htmlPrice, source: "allorigins+HTML스크래핑" };
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchYahooTrailingDividendYieldByCode(
  code: string
): Promise<{ dividendYield: number; source: string } | null> {
  const symbols = getYahooSymbolsForKrx(code);
  for (const symbol of symbols) {
    try {
      const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y&events=div`;
      const payload = await fetchJsonViaProxyStrategies<YahooChartResponse>(targetUrl);
      const dividendYield = parseYahooTrailingDividendYield(payload);
      if (dividendYield == null || !Number.isFinite(dividendYield) || dividendYield < 0) continue;
      return { dividendYield, source: `yahoo-div:${symbol}` };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchYahooHistoryByCodeWithRange(
  code: string,
  range: "1y" | "6mo" | "3mo" | "1mo"
): Promise<PricePoint[] | null> {
  const symbols = getYahooSymbolsForKrx(code);
  for (const symbol of symbols) {
    try {
      const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const payload = await fetchJsonViaProxyStrategies<YahooChartResponse>(targetUrl);
      const points = parseYahooHistory(payload);
      if (points.length > 0) return points;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchYahooOneYearHistoryByCode(code: string): Promise<PricePoint[] | null> {
  const points = await fetchYahooHistoryByCodeWithRange(code, "1y");
  if (!points || points.length < HISTORY_MIN_POINTS) return null;
  return trimLatestHistoryPoints(points);
}

async function fetchPriceHistoryPage(code: string, page: number): Promise<PricePoint[]> {
  const targetUrl = `https://m.stock.naver.com/api/stock/${code}/price?page=${page}&pageSize=60`;
  const rows = await fetchJsonViaProxyStrategies<
    Array<{ localTradedAt?: string; closePrice?: string | number }>
  >(targetUrl);

  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      date: String(row.localTradedAt ?? ""),
      close: parsePrice(row.closePrice),
    }))
    .filter((row) => row.date && row.close > 0);
}

export async function fetchOneYearHistoryByCode(code: string): Promise<PricePoint[] | null> {
  const yahooHistory = await fetchYahooOneYearHistoryByCode(code);
  if (yahooHistory) return yahooHistory;

  const merged: PricePoint[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 6; page += 1) {
    try {
      const pageRows = await fetchPriceHistoryPage(code, page);
      if (pageRows.length === 0) break;

      for (const row of pageRows) {
        if (seen.has(row.date)) continue;
        seen.add(row.date);
        merged.push(row);
      }

      if (merged.length >= HISTORY_TARGET_POINTS) break;
    } catch {
      break;
    }
  }

  if (merged.length < HISTORY_MIN_POINTS) return null;
  merged.sort((a, b) => a.date.localeCompare(b.date));
  return trimLatestHistoryPoints(merged);
}

async function fetchNaverRecentHistoryPages(
  code: string,
  knownLatestDate: string | null,
  maxPages = 2
): Promise<PricePoint[]> {
  const collected: PricePoint[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const pageRows = await fetchPriceHistoryPage(code, page);
      if (pageRows.length === 0) break;
      let hasNewer = false;
      for (const row of pageRows) {
        if (!knownLatestDate || row.date > knownLatestDate) {
          collected.push(row);
          hasNewer = true;
        }
      }
      if (knownLatestDate && !hasNewer) break;
    } catch {
      break;
    }
  }
  return normalizeHistoryPoints(collected);
}

async function fetchIncrementalOneYearHistoryByCode(
  code: string,
  existing: PricePoint[],
  recentStaleDays = HISTORY_STALE_DAYS_DEFAULT
): Promise<PricePoint[] | null> {
  let merged = normalizeHistoryPoints(existing);
  const knownLatestDate = getLatestHistoryDate(merged);

  const yahooRecent = await fetchYahooHistoryByCodeWithRange(code, "3mo");
  if (yahooRecent && yahooRecent.length > 0) {
    merged = mergeHistoryPoints(merged, yahooRecent);
    if (isHistoryRecent(merged, recentStaleDays) && merged.length >= HISTORY_MIN_POINTS) {
      return trimLatestHistoryPoints(merged);
    }
  }

  const naverRecent = await fetchNaverRecentHistoryPages(code, knownLatestDate, 2);
  if (naverRecent.length > 0) {
    merged = mergeHistoryPoints(merged, naverRecent);
    if (isHistoryRecent(merged, recentStaleDays) && merged.length >= HISTORY_MIN_POINTS) {
      return trimLatestHistoryPoints(merged);
    }
  }

  const full = await fetchOneYearHistoryByCode(code);
  if (full) return trimLatestHistoryPoints(mergeHistoryPoints(merged, full));
  if (merged.length >= HISTORY_MIN_POINTS) return trimLatestHistoryPoints(merged);
  return null;
}

export async function fetchOneYearHistoriesByCodes(
  codes: string[],
  onProgress?: (progress: HistoryProgress) => void,
  options?: HistoryFetchOptions
): Promise<HistoryFetchResult> {
  const existingHistoryByCode = options?.existingHistoryByCode ?? {};
  const preferIncremental = options?.preferIncremental ?? true;
  const recentStaleDays = options?.recentStaleDays ?? HISTORY_STALE_DAYS_DEFAULT;

  const historyByCode: Record<string, PricePoint[]> = {};
  const failedCodes: string[] = [];
  let successCount = 0;

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    const existing = normalizeHistoryPoints(existingHistoryByCode[code] ?? []);

    if (isHistoryRecent(existing, recentStaleDays)) {
      historyByCode[code] = trimLatestHistoryPoints(existing);
      successCount += 1;
      onProgress?.({
        done: i + 1,
        total: codes.length,
        code,
        successCount,
        failedCount: failedCodes.length,
      });
      continue;
    }

    let history: PricePoint[] | null = null;
    if (preferIncremental && existing.length > 0) {
      history = await fetchIncrementalOneYearHistoryByCode(code, existing, recentStaleDays);
    } else {
      history = await fetchOneYearHistoryByCode(code);
    }

    if (!history && existing.length >= HISTORY_MIN_POINTS) {
      history = trimLatestHistoryPoints(existing);
    }

    if (!history) {
      failedCodes.push(code);
      onProgress?.({
        done: i + 1,
        total: codes.length,
        code,
        successCount,
        failedCount: failedCodes.length,
      });
      continue;
    }
    historyByCode[code] = trimLatestHistoryPoints(history);
    successCount += 1;
    onProgress?.({
      done: i + 1,
      total: codes.length,
      code,
      successCount,
      failedCount: failedCodes.length,
    });
  }

  return { historyByCode, failedCodes };
}

export async function fetchPricesByCodes(
  codes: string[],
  onProgress?: (progress: PriceProgress) => void
): Promise<PriceFetchResult> {
  const prices: Record<string, number> = {};
  const sourceByCode: Record<string, string> = {};
  const failedCodes: string[] = [];
  let successCount = 0;
  let failedCount = 0;
  let doneCount = 0;
  let cursor = 0;
  const total = codes.length;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) break;

      const code = codes[index];
      const result = await fetchSinglePrice(code);
      if (!result) {
        failedCodes.push(code);
        failedCount += 1;
        doneCount += 1;
        onProgress?.({
          done: doneCount,
          total,
          code,
          successCount,
          failedCount,
          result: null,
        });
        continue;
      }

      prices[code] = result.price;
      sourceByCode[code] = result.source;
      successCount += 1;
      doneCount += 1;
      onProgress?.({
        done: doneCount,
        total,
        code,
        successCount,
        failedCount,
        result,
      });
    }
  };

  const workerCount = Math.max(1, Math.min(PRICE_FETCH_CONCURRENCY, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (total === 0) {
    onProgress?.({
      done: 0,
      total: 0,
      code: "",
      successCount: 0,
      failedCount: 0,
      result: null,
    });
  }

  return { prices, sourceByCode, failedCodes };
}

export async function fetchDividendYieldsByCodes(
  codes: string[],
  onProgress?: (progress: DividendYieldProgress) => void
): Promise<DividendYieldFetchResult> {
  const dividendYieldByCode: Record<string, number> = {};
  const sourceByCode: Record<string, string> = {};
  const failedCodes: string[] = [];
  let successCount = 0;
  let failedCount = 0;
  let doneCount = 0;
  let cursor = 0;
  const total = codes.length;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) break;

      const code = codes[index];
      const cached = getCachedDividendYield(code);
      if (cached) {
        dividendYieldByCode[code] = cached.dividendYield;
        sourceByCode[code] = cached.source;
        successCount += 1;
        doneCount += 1;
        onProgress?.({
          done: doneCount,
          total,
          code,
          successCount,
          failedCount,
          result: cached,
        });
        continue;
      }

      const fetched = await fetchYahooTrailingDividendYieldByCode(code);
      if (!fetched) {
        failedCodes.push(code);
        failedCount += 1;
        doneCount += 1;
        onProgress?.({
          done: doneCount,
          total,
          code,
          successCount,
          failedCount,
          result: null,
        });
        continue;
      }

      const rounded = Math.round((fetched.dividendYield + Number.EPSILON) * 100) / 100;
      dividendYieldByCode[code] = rounded;
      sourceByCode[code] = fetched.source;
      setCachedDividendYield(code, rounded, fetched.source);
      successCount += 1;
      doneCount += 1;
      onProgress?.({
        done: doneCount,
        total,
        code,
        successCount,
        failedCount,
        result: { dividendYield: rounded, source: fetched.source },
      });
    }
  };

  const workerCount = Math.max(1, Math.min(DIVIDEND_FETCH_CONCURRENCY, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (total === 0) {
    onProgress?.({
      done: 0,
      total: 0,
      code: "",
      successCount: 0,
      failedCount: 0,
      result: null,
    });
  }

  return { dividendYieldByCode, sourceByCode, failedCodes };
}
