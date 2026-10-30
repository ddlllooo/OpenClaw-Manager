import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
export const bytes = (n) => {
  if (!Number.isFinite(n)) return "—";
  const i = Math.min(4, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
};
export const date = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const instancePath = (id, suffix = "") =>
  `/api/instances/${encodeURIComponent(id)}${suffix}`;
export function networkRate(previous, current) {
  if (!previous || !current || current.ts <= previous.ts) return null;
  const totals = (sample) =>
    Object.values(sample.net || {}).reduce(
      (sum, row) => ({
        rx: sum.rx + (row.rxBytes || 0),
        tx: sum.tx + (row.txBytes || 0),
      }),
      { rx: 0, tx: 0 },
    );
  const before = totals(previous),
    after = totals(current),
    seconds = (current.ts - previous.ts) / 1000;
  if (after.rx < before.rx || after.tx < before.tx) return null;
  return {
    rx: (after.rx - before.rx) / seconds,
    tx: (after.tx - before.tx) / seconds,
  };
}
