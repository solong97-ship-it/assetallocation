/**
 * 15개 ETF 1년 히스토리 기반 최적 포트폴리오 탐색
 *
 * 제약:
 *  - 주식≥1, 금≥1, 채권≥1, KOFR≥1
 *  - 모든 종목 비중 < 20%  (정수 단위, 최대 19%)
 *  - 개별 주식 종목 비중 ≤ 10%
 *  - KOFR ≥ 5%
 *  - 안전자산(채권+KOFR) 비중 ≥ 30%
 *  - 포트폴리오 배당수익률 3% ~ 4%
 * 목표: (1) CAGR 최대 (2) MDD 최소 (3) 배당 큰 조합 우선
 *
 * 알고리즘:
 *  Phase 1 – 종목 조합 × 비중 그리드(step=5) → 조합별 상위 3개 quick score
 *  Phase 2 – 상위 후보에 local search (±1% 정수 단위) → 제약 내 최적화
 *  Phase 3 – 252일 full KPI 계산 → 복합 점수 정렬 → 상위 N개 반환
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

/* ── 상수 ── */

const TRADING_DAYS = 252;
const MIN_POINTS = 30;
const MAX_POINTS = 252;

const STOCK_MAX = 10;    // 개별 주식 최대 %
const GLOBAL_MAX = 19;   // 모든 종목 최대 % (20% 미만)
const KOFR_MIN = 5;      // KOFR 최소 %
const SAFE_MIN = 30;     // 안전자산(채권+KOFR) 최소 %
const DIV_MIN = 3.0;     // 포트폴리오 배당수익률 최소 %
const DIV_MAX = 4.0;     // 포트폴리오 배당수익률 최대 %
const COARSE_STEP = 5;   // 1차 그리드 간격
const COARSE_MIN = 5;    // 1차 그리드 최소

/* ── 유틸 ── */

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

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

/** 비중 파티션 순회 (제약 지원) */
function iterateWeightsConstrained(
  n: number,
  total: number,
  step: number,
  mins: number[],
  maxs: number[],
  cb: (w: number[]) => void,
): void {
  const buf = new Array<number>(n);
  const suffixMin = new Array<number>(n + 1);
  suffixMin[n] = 0;
  for (let k = n - 1; k >= 0; k--) suffixMin[k] = suffixMin[k + 1] + mins[k];

  function rec(rem: number, d: number) {
    if (d === n - 1) {
      if (rem >= mins[d] && rem <= maxs[d]) { buf[d] = rem; cb(buf); }
      return;
    }
    const lo = mins[d];
    const hi = Math.min(maxs[d], rem - suffixMin[d + 1]);
    for (let w = lo; w <= hi; w += step) {
      buf[d] = w;
      rec(rem - w, d + 1);
    }
  }
  rec(total, 0);
}

/** quick score 계산 (final return + 배당 보너스) */
function quickScore(
  indices: number[],
  weights: number[],
  finalRet: number[],
  divY: number[],
): number {
  let qr = 0;
  let dy = 0;
  for (let j = 0; j < indices.length; j++) {
    const w = weights[j] / 100;
    qr += w * finalRet[indices[j]];
    dy += w * divY[indices[j]];
  }
  return (qr - 1) * 100 + dy * 0.1;
}

/**
 * Local search: ±1% 이동으로 정수 비중 최적화 (quick score 기준)
 * coarse grid 결과를 정수 단위로 세밀 조정
 */
function localSearchRefine(
  indices: number[],
  startWeights: number[],
  finalRet: number[],
  divY: number[],
  mins: number[],
  maxs: number[],
  safeFlags: boolean[],
): number[] {
  const N = indices.length;
  const w = [...startWeights];

  // 런닝 토탈: 안전자산 비중 & 배당수익률
  let safeTotal = 0;
  let divTotal = 0;
  for (let k = 0; k < N; k++) {
    if (safeFlags[k]) safeTotal += w[k];
    divTotal += (w[k] / 100) * divY[indices[k]];
  }

  for (let iter = 0; iter < 100; iter++) {
    let improved = false;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        // i → j 로 1% 이동 시도
        if (w[i] - 1 >= mins[i] && w[j] + 1 <= maxs[j]) {
          // 안전자산 제약 체크
          const newSafe = safeTotal + (safeFlags[j] ? 1 : 0) - (safeFlags[i] ? 1 : 0);
          if (newSafe < SAFE_MIN) continue;
          // 배당 제약 체크
          const newDiv = divTotal + (-divY[indices[i]] + divY[indices[j]]) / 100;
          if (newDiv < DIV_MIN || newDiv > DIV_MAX) continue;

          const before = quickScore(indices, w, finalRet, divY);
          w[i]--;
          w[j]++;
          const after = quickScore(indices, w, finalRet, divY);
          if (after > before) {
            improved = true;
            safeTotal = newSafe;
            divTotal = newDiv;
          } else {
            w[i]++;
            w[j]--;
          }
        }
      }
    }
    if (!improved) break;
  }

  return w;
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
  const toIdx = (arr: typeof available) => arr.map((e) => codeToIdx.get(e.code)!);
  const goldIs = toIdx(golds);
  const kofrIs = toIdx(kofrs);
  const stockSubs = subsets(toIdx(stocks), 1, 4);
  const bondSubs  = subsets(toIdx(bonds),  1, 4);
  const extraSubs = subsets(toIdx(extras), 0, 2);

  // ────────────────────────────────────────
  // Phase 1: 종목 조합별 coarse grid (step=5) → quick score 상위 선별
  // ────────────────────────────────────────
  type Cand = { indices: number[]; weights: number[]; qs: number };
  const TOP_PER = 3;
  const allCoarse: Cand[] = [];

  // coarse grid max: 가장 가까운 step 배수 ≤ GLOBAL_MAX
  const coarseMax = Math.floor(GLOBAL_MAX / COARSE_STEP) * COARSE_STEP; // 15

  for (const ss of stockSubs) {
    for (const bs of bondSubs) {
      for (const es of extraSubs) {
        const idxArr = [...goldIs, ...kofrIs, ...ss, ...bs, ...es];
        const N = idxArr.length;

        // 항목별 coarse 제약
        const cMins: number[] = [];
        const cMaxs: number[] = [];
        const gC = goldIs.length;
        const kC = kofrIs.length;
        const sC = ss.length;

        for (let p = 0; p < N; p++) {
          if (p < gC) {
            cMins.push(COARSE_MIN); cMaxs.push(coarseMax);
          } else if (p < gC + kC) {
            cMins.push(Math.max(KOFR_MIN, COARSE_MIN)); cMaxs.push(coarseMax);
          } else if (p < gC + kC + sC) {
            cMins.push(COARSE_MIN); cMaxs.push(Math.min(STOCK_MAX, coarseMax));
          } else {
            cMins.push(COARSE_MIN); cMaxs.push(coarseMax);
          }
        }

        // 실현 가능성 체크
        const minSum = cMins.reduce((s, m) => s + m, 0);
        const maxSum = cMaxs.reduce((s, m) => s + m, 0);
        if (minSum > 100 || maxSum < 100) continue;

        // 안전자산 플래그
        const safeFlags = idxArr.map((ii) => available[ii].category === "안전자산");

        const comboTop: Cand[] = [];
        let comboMin = -Infinity;

        iterateWeightsConstrained(N, 100, COARSE_STEP, cMins, cMaxs, (wts) => {
          // 안전자산 ≥ 30% 체크
          let safeW = 0;
          for (let p = 0; p < N; p++) if (safeFlags[p]) safeW += wts[p];
          if (safeW < SAFE_MIN) return;

          // 배당 3~4% 체크 (coarse grid는 여유분 ±1% 허용)
          let dy = 0;
          for (let p = 0; p < N; p++) dy += (wts[p] / 100) * divY[idxArr[p]];
          if (dy < DIV_MIN - 1 || dy > DIV_MAX + 1) return;

          const score = quickScore(idxArr, wts, finalRet, divY);
          if (comboTop.length < TOP_PER || score > comboMin) {
            comboTop.push({ indices: [...idxArr], weights: [...wts], qs: score });
            comboTop.sort((a, b) => b.qs - a.qs);
            if (comboTop.length > TOP_PER) comboTop.pop();
            comboMin = comboTop[comboTop.length - 1]?.qs ?? -Infinity;
          }
        });
        allCoarse.push(...comboTop);
      }
    }
  }

  // ────────────────────────────────────────
  // Phase 2: 상위 후보 local search → 정수(1%) 단위 최적화
  // ────────────────────────────────────────
  allCoarse.sort((a, b) => b.qs - a.qs);
  const topCoarse = allCoarse.slice(0, 500);

  const refined: Cand[] = [];

  for (const cand of topCoarse) {
    const { indices } = cand;
    const N = indices.length;

    // 진짜 제약 (정수 단위)
    const rMins: number[] = [];
    const rMaxs: number[] = [];
    // available[idx].group 으로 제약 판별
    for (let p = 0; p < N; p++) {
      const grp = available[indices[p]].group;
      if (grp === "kofr") {
        rMins.push(KOFR_MIN); rMaxs.push(GLOBAL_MAX);
      } else if (grp === "stock") {
        rMins.push(1); rMaxs.push(Math.min(STOCK_MAX, GLOBAL_MAX));
      } else {
        rMins.push(1); rMaxs.push(GLOBAL_MAX);
      }
    }

    const safeFlags = indices.map((ii) => available[ii].category === "안전자산");
    const w = localSearchRefine(indices, cand.weights, finalRet, divY, rMins, rMaxs, safeFlags);
    const qs = quickScore(indices, w, finalRet, divY);
    refined.push({ indices: [...indices], weights: w, qs });
  }

  // ────────────────────────────────────────
  // Phase 3: full KPI 계산
  // ────────────────────────────────────────
  refined.sort((a, b) => b.qs - a.qs);
  const finalists = refined.slice(0, 500);
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

    // 최종 제약 필터: 안전자산 ≥ 30%, 배당 3~4%
    if (safeW < SAFE_MIN) continue;
    if (annDY < DIV_MIN || annDY > DIV_MAX) continue;

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
