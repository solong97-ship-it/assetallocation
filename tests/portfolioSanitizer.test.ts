import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sanitizeNonNegativeNumber,
  sanitizePortfoliosFromUnknown,
} from "../src/utils/portfolioSanitizer";

const sampleDir = join(process.cwd(), "tests", "json-samples");

function readJson(fileName: string): unknown {
  const raw = readFileSync(join(sampleDir, fileName), "utf-8");
  return JSON.parse(raw) as unknown;
}

describe("portfolioSanitizer", () => {
  it("keeps a valid portfolio", () => {
    const input = readJson("valid-basic.json");
    const result = sanitizePortfoliosFromUnknown(input);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my_portfolio");
    expect(result[0].name).toBe("테스트 포트");
    expect(result[0].items).toHaveLength(1);
    expect(result[0].items[0].category).toBe("안전자산");
  });

  it("sanitizes dirty values and deduplicates portfolio ids", () => {
    const input = readJson("valid-dirty-duplicate-ids.json");
    const result = sanitizePortfoliosFromUnknown(input);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("dup_id");
    expect(result[1].id).toBe("dup_id_2");

    expect(result[0].name).toBe("불러온 포트폴리오 1");
    expect(result[0].principal).toBe(0);
    expect(result[0].items[0].category).toBe("위험자산");
    expect(result[0].items[0].subCategory).toBe("기타");
    expect(result[0].items[0].code).toBe("12-34");
    expect(result[0].items[0].price).toBe(0);
    expect(result[0].items[0].weight).toBe(0);
    expect(result[0].kpi.annualDividendYield).toBe(1.5);
  });

  it("returns empty list when input is not an array", () => {
    const input = readJson("invalid-not-array.json");
    const result = sanitizePortfoliosFromUnknown(input);

    expect(result).toEqual([]);
  });

  it("returns empty list when every portfolio has empty items", () => {
    const input = readJson("invalid-empty-items.json");
    const result = sanitizePortfoliosFromUnknown(input);

    expect(result).toEqual([]);
  });

  it("sanitizes non-negative numeric values", () => {
    expect(sanitizeNonNegativeNumber(12.5)).toBe(12.5);
    expect(sanitizeNonNegativeNumber("7.3")).toBe(7.3);
    expect(sanitizeNonNegativeNumber(-1)).toBe(0);
    expect(sanitizeNonNegativeNumber("abc", 99)).toBe(99);
  });
});
