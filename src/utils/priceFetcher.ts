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

async function fetchJsonViaProxyStrategies<T>(targetUrl: string): Promise<T> {
  const strategies: Array<{ name: string; run: () => Promise<T> }> = [
    {
      name: "allorigins-raw",
      run: () =>
        fetchJsonFromTextEndpoint<T>(
          `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
          15000
        ),
    },
    {
      name: "jina-ai",
      run: () =>
        fetchJsonFromTextEndpoint<T>(
          `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//, "")}`,
          18000
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

async function fetchNaverViaProxy(
  code: string,
  proxyType: "allorigins" | "corsproxy"
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

  const timeout = createTimeoutSignal(12000);
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

async function fetchNaverHtmlScrape(code: string): Promise<number> {
  const pageUrl = `https://finance.naver.com/item/main.naver?code=${code}`;
  const fetchUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(pageUrl)}`;
  const timeout = createTimeoutSignal(15000);
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
  const strategies: Array<{
    name: string;
    run: () => Promise<number>;
  }> = [
    { name: "allorigins+네이버API", run: () => fetchNaverViaProxy(code, "allorigins") },
    { name: "corsproxy+네이버API", run: () => fetchNaverViaProxy(code, "corsproxy") },
    { name: "allorigins+HTML스크래핑", run: () => fetchNaverHtmlScrape(code) },
  ];

  for (const strategy of strategies) {
    try {
      const price = await strategy.run();
      if (price > 0) return { price, source: strategy.name };
    } catch {
      continue;
    }
  }
  return null;
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

      if (merged.length >= 252) break;
    } catch {
      break;
    }
  }

  if (merged.length < 30) return null;
  merged.sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

export async function fetchOneYearHistoriesByCodes(
  codes: string[],
  onProgress?: (done: number, total: number, code: string) => void
): Promise<HistoryFetchResult> {
  const historyByCode: Record<string, PricePoint[]> = {};
  const failedCodes: string[] = [];

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    onProgress?.(i + 1, codes.length, code);
    const history = await fetchOneYearHistoryByCode(code);
    if (!history) {
      failedCodes.push(code);
      continue;
    }
    historyByCode[code] = history;
  }

  return { historyByCode, failedCodes };
}

export async function fetchPricesByCodes(
  codes: string[],
  onProgress?: (done: number, total: number, code: string) => void
): Promise<PriceFetchResult> {
  const prices: Record<string, number> = {};
  const sourceByCode: Record<string, string> = {};
  const failedCodes: string[] = [];

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    onProgress?.(i + 1, codes.length, code);
    const result = await fetchSinglePrice(code);
    if (!result) {
      failedCodes.push(code);
      continue;
    }
    prices[code] = result.price;
    sourceByCode[code] = result.source;
  }

  return { prices, sourceByCode, failedCodes };
}
