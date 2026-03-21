export type AssetCategory = "위험자산" | "안전자산";

export type AssetItem = {
  id: string;
  category: AssetCategory;
  subCategory: string;
  dividendYield: number;
  name: string;
  code: string;
  price: number;
  weight: number;
};

export type PortfolioKPI = {
  cagr: number;
  mdd: number;
  sharpe: number;
  annualDividendYield: number;
};

export type Portfolio = {
  id: string;
  name: string;
  principalLabel: "투자금" | "원금";
  principal: number;
  items: AssetItem[];
  kpi: PortfolioKPI;
  isCustom?: boolean;
};
