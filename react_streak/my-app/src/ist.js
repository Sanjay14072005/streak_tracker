const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // fixed (no DST in India)
const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

const toIST = (utcMs) => new Date(utcMs + IST_OFFSET_MS);

export const istDayKey = () => ymdFromISTNow();

export function ymdFromISTNow() {
  const istNow = toIST(Date.now());
  return `${istNow.getUTCFullYear()}-${pad(istNow.getUTCMonth() + 1)}-${pad(
    istNow.getUTCDate()
  )}`;
}

export function istYesterdayLabel(label) {
  const [y, m, d] = label.split("-").map(Number);
  // IST midnight for the given label → back to UTC → subtract a day → back to IST → format
  const istMidnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS;
  const prevIst = toIST(istMidnightUtc - DAY_MS);
  return `${prevIst.getUTCFullYear()}-${pad(prevIst.getUTCMonth() + 1)}-${pad(
    prevIst.getUTCDate()
  )}`;
}

export function nextISTMidnightUtcMs() {
  const istNow = toIST(Date.now());
  // Build (next day at 00:00) in IST's calendar fields, then convert to UTC ms
  const nextIstMidnightUtcFields = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate() + 1,
    0,
    0,
    0
  );
  return nextIstMidnightUtcFields - IST_OFFSET_MS;
}
