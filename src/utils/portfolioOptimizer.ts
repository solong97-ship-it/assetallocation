/**
 * 15개 ETF 1년 히스토리 기반 최적 포트폴리오 탐색
 *
 * 제약: 주식≥1, 금≥1, 채권≥1, KOFR≥1
 * 목표: (1) CAGR 최대 (2) MDD 최소 (3) 배당 큰 조합 우선
 *
 * 알고리즘:
 *  Phase 1 – 모든 종목 조합 × 비중 그리드(5%단위) → quick score(최종수익률) 상위 3개/조합
 *  Phase 2 – 상위 후보 전체에 대해 252일 full KPI 계산 → 복합 점수 정렬 → 상위 N개 반환
 */

import type { PortfolioKPI } from "../types/portfolio";
import type { PricePoint } from "./kpiCalculator";

/* ── 결과 타입 ── */

export type OptimalItem = {
  code: string;
  name: string;
  category: string;
  subCategory: string;
  weight: number;
  dividendYield: number;
};

export type OptimalResult = {
  rank: number;
  items: OptimalItem[];
  kpi: PortfolioKPI;
  score: number;
  periodStart: string;
  periodEnd: string;
  safeWeight: number;
};

/* ── ETF 유니버스 ── */

type ETFDef = {
  code: string;
  name: string;
  category: string;
  subCategory: string;
  defaultDividendYield: number;
  group: "stock" | "gold" | "bond" | "kofr" | "extra";
};

const ETF_DEFS: ETFDef[] = [
  { code: "379800", name: "KODEX 미국S&P500",          category: "위험자산", subCategory: "주식(미국)", defaultDividendYield: 1.74, group: "stock" },
  { code: "294400", name: "KIWOOM 200TR",              category: "위험자산", subCategory: "주식(한국)", defaultDividendYield: 0,    group: "stock" },
  { code: "283580", name: "KODEX 차이나CSI300",        category: "위험자산", subCategory: "주식(중국)", defaultDividendYield: 2.05, group: "stock" },
  { code: "453810", name: "KODEX 인도Nifty50",         category: "위험자산", subCategory: "주식(인도)", defaultDividendYield: 1.24, group: "stock" },
  { code: "379810", name: "KODEX 미국나스닥100",       category: "위험자산", subCategory: "주식(미국)", defaultDividendYield: 0.94, group: "stock" },
  { code: "446720", name: "SOL 미국배당다우존스",      category: "위험자산", subCategory: "주식(미국)", defaultDividendYield: 2.95, group: "stock" },
  { code: "411060", name: "ACE KRX금현물",             category: "위험자산", subCategory: "원자재",     defaultDividendYield: 0,    group: "gold" },
  { code: "308620", name: "KODEX 미국10년국채선물",    category: "안전자산", subCategory: "채권",       defaultDividendYield: 1.29, group: "bond" },
  { code: "453850", name: "ACE 미국30년국채액티브(H)", category: "안전자산", subCategory: "채권",       defaultDividendYield: 3.86, group: "bond" },
  { code: "385560", name: "RISE KIS국고채30년Enhanced", category: "안전자산", subCategory: "채권",      defaultDividendYield: 3.27, group: "bond" },
  { code: "284430", name: "KODEX 200미국채혼합",       category: "안전자산", subCategory: "혼합",       defaultDividendYield: 1.1,  group: "bond" },
  { code: "490490", name: "SOL 미국배당미국채혼합50",  category: "안전자산", subCategory: "혼합",       defaultDividendYield: 2.82, group: "bond" },
  { code: "449170", name: "TIGER KOFR금리액티브(합성)", category: "안전자산", subCategory: "현금",      defaultDividendYield: 0.62, group: "kofr" },
  { code: "441640", name: "KODEX 미국배당커버드콜액티브", category: "위험자산", subCategory: "커버드콜", defaultDividendYield: 8.8, group: "extra" },
  { code: "329200", name: "TIGER 리츠부동산인프라",    category: "위험자산", subCategory: "리츠",       defaultDividendYield: 8.78, group: "extra" },
];

export const OPTIMIZER_ALL_CODES = ETF_DEFS.map((e) => e.code);

/* ── 유틸 ── */

const TRADING_DAYS = 252;
const MIN_POINTS = 30;
const MAX_POINTS = 252;

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** k-element subsets from arr[startIdx..] */
function subsets(arr: number[], minK: number, maxK: number): number[][] {
  const result: number[][] = [];
  function rec(start: number, cur: number[]) {
    if (cur.length >= minK) result.push([...cur]);
    if (cur.length >= maxK) return;
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  }
  rec(0, []);
  return result;
}

/** 비중 파티션 순회: n개 항목, 합계=total, 최소=min, 간격=step */
function iterateWeights(
  n: number,
  total: number,
  step: number,
  min: number,
  cb: (w: number[]) => void,
): void {
  const buf = new Array<number>(n);
  function rec(rem: number, d: number) {
    if (d === n - 1) {
      if (rem >= min) { buf[d] = rem; cb(buf); }
      return;
    }
    const maxW = rem - (n - d - 1) * min;
    for (let w = min; w <= maxW; w += step) {
      buf[d] = w;
      rec(rem - w, d + 1);
    }
  }
  rec(total, 0);
}

/* ── 메인 ── */

export function findOptimalPortfolios(
  historyByCode: Record<string, PricePoint[]>,
  dividendYieldByCode: Record<string, number>,
  topN = 3,
): OptimalResult[] {
  // 1. 히스토리 충분한 ETF만 선별
  const available = ETF_DEFS.filter(
    (e) => (historyByCode[e.code]?.length ?? 0) >= MIN_POINTS,
  );
  const byGroup = (g: string) => available.filter((e) => e.group === g);
  const stocks = byGroup("stock");
  const golds  = byGroup("gold");
  const bonds  = byGroup("bond");
  const kofrs  = byGroup("kofr");
  const extras = byGroup("extra");
  if (!stocks.length || !golds.length || !bonds.length || !kofrs.length) return [];

  // 2. 공통 거래일 산출
  let commonSet = new Set(historyByCode[available[0].code].map((p) => p.date));
  for (let i = 1; i < available.length; i++) {
    const ds = new Set(historyByCode[available[i].code].map((p) => p.date));
    for (const d of [...commonSet]) if (!ds.has(d)) commonSet.delete(d);
  }
  const dates = [...commonSet].sort().slice(-MAX_POINTS);
  if (dates.length < MIN_POINTS) return [];
  const T = dates.length;

  // 3. 정규화 수익률 행렬 (ETF × 거래일)
  const codeToIdx = new Map(available.map((e, i) => [e.code, i]));
  const retMatrix: number[][] = available.map((etf) => {
    const pm = new Map(historyByCode[etf.code].map((p) => [p.date, p.close]));
    const base = pm.get(dates[0]) ?? 1;
    return base > 0
      ? dates.map((d) => (pm.get(d) ?? base) / base)
      : dates.map(() => 1);
  });
  const finalRet = retMatrix.map((s) => s[T - 1]);
  const divY = available.map(
    (e) => dividendYieldByCode[e.code] ?? e.defaultDividendYield,
  );

  // 4. 종목 조합 생성
  const idx = (arr: typeof available) => arr.map((e) => codeToIdx.get(e.code)!);
  const goldIs = idx(golds);
  const kofrIs = idx(kofrs);
  const stockSubs = subsets(idx(stocks), 1, 2);
  const bondSubs  = subsets(idx(bonds),  1, 2);
  const extraSubs = subsets(idx(extras), 0, 1);

  // 5. Phase 1: quick scoring (최종 수익률 기반)
  type Cand = { indices: number[]; weights: number[]; qs: number };
  const TOP_PER = 3;
  const allTop: Cand[] = [];

  for (const ss of stockSubs) {
    for (const bs of bondSubs) {
      for (const es of extraSubs) {
        const idxArr = [...goldIs, ...kofrIs, ...ss, ...bs, ...es];
        const N = idxArr.length;
        const comboTop: Cand[] = [];
        let comboMin = -Infinity;

        iterateWeights(N, 100, 5, 5, (wts) => {
          let qr = 0;
          let dy = 0;
          for (let j = 0; j < N; j++) {
            const w = wts[j] / 100;
            qr += w * finalRet[idxArr[j]];
            dy += w * divY[idxArr[j]];
          }
          const score = (qr - 1) * 100 + dy * 0.1;
          if (comboTop.length < TOP_PER || score > comboMin) {
            comboTop.push({ indices: [...idxArr], weights: [...wts], qs: score });
            comboTop.sort((a, b) => b.qs - a.qs);
            if (comboTop.length > TOP_PER) comboTop.pop();
            comboMin = comboTop[comboTop.length - 1]?.qs ?? -Infinity;
          }
        });
        allTop.push(...comboTop);
      }
    }
  }

  // 6. Phase 2: full KPI 계산 (상위 3000개)
  allTop.sort((a, b) => b.qs - a.qs);
  const finalists = allTop.slice(0, 3000);
  const results: OptimalResult[] = [];

  for (const cand of finalists) {
    const { indices, weights } = cand;
    const N = indices.length;

    // 포트폴리오 인덱스 시계열
    const series = new Array<number>(T);
    for (let t = 0; t < T; t++) {
      let v = 0;
      for (let j = 0; j < N; j++) v += (weights[j] / 100) * retMatrix[indices[j]][t];
      series[t] = v;
    }

    // 배당수익률
    let annDY = 0;
    for (let j = 0; j < N; j++) annDY += (weights[j] / 100) * divY[indices[j]];

    // CAGR (배당 재투자 반영)
    const dailyDR = annDY / 100 / TRADING_DAYS;
    const tr: number[] = [1];
    for (let i = 1; i < T; i++) {
      const prev = series[i - 1];
      const next = series[i];
      if (prev <= 0 || next <= 0) { tr.push(tr[i - 1]); continue; }
      tr.push(tr[i - 1] * ((1 + next / prev - 1) * (1 + dailyDR)));
    }
    const years = Math.max((T - 1) / TRADING_DAYS, 1 / TRADING_DAYS);
    const cagr =
      tr[0] > 0 && tr[T - 1] > 0
        ? (Math.pow(tr[T - 1] / tr[0], 1 / years) - 1) * 100
        : 0;

    // MDD
    let peak = series[0];
    let maxDD = 0;
    for (let i = 0; i < T; i++) {
      if (series[i] > peak) peak = series[i];
      const dd = peak > 0 ? ((peak - series[i]) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe
    const dRets: number[] = [];
    for (let i = 1; i < T; i++) {
      if (series[i - 1] > 0) dRets.push(series[i] / series[i - 1] - 1);
    }
    const meanD = dRets.length > 0 ? dRets.reduce((s, r) => s + r, 0) / dRets.length : 0;
    const varD =
      dRets.length > 1
        ? dRets.reduce((s, r) => s + (r - meanD) ** 2, 0) / (dRets.length - 1)
        : 0;
    const sharpe = Math.sqrt(varD) > 0 ? (meanD / Math.sqrt(varD)) * Math.sqrt(TRADING_DAYS) : 0;

    // 안전자산 비중
    let safeW = 0;
    for (let j = 0; j < N; j++) {
      if (available[indices[j]].category === "안전자산") safeW += weights[j];
    }

    const score = cagr - 0.3 * maxDD + 0.1 * annDY;

    results.push({
      rank: 0,
      items: indices.map((ii, j) => ({
        code: available[ii].code,
        name: available[ii].name,
        category: available[ii].category,
        subCategory: available[ii].subCategory,
        weight: weights[j],
        dividendYield: round2(divY[ii]),
      })),
      kpi: {
        cagr: round2(cagr),
        mdd: round2(maxDD),
        sharpe: round2(sharpe),
        annualDividendYield: round2(annDY),
      },
      score: round2(score),
      periodStart: dates[0],
      periodEnd: dates[T - 1],
      safeWeight: safeW,
    });
  }

  // 점수순 정렬 + 중복 제거
  results.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const unique: OptimalResult[] = [];
  for (const r of results) {
    const key = r.items
      .map((i) => `${i.code}:${i.weight}`)
      .sort()
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= topN) break;
  }

  return unique.map((r, i) => ({ ...r, rank: i + 1 }));
}
