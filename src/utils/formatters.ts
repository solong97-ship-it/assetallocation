const krwFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const shareFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 4,
});

const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 1,
});

export const formatCurrencyKRW = (value: number): string => {
  return `${krwFormatter.format(Math.round(value))}원`;
};

export const formatPercent = (value: number): string => {
  return `${percentFormatter.format(value)}%`;
};

export const formatNumber = (value: number): string => {
  return numberFormatter.format(value);
};

export const formatShareNumber = (value: number): string => {
  return shareFormatter.format(value);
};
