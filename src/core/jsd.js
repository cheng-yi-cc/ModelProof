// Jensen-Shannon divergence, base 2 (bounded [0,1]) — identical formula to
// PAMELA stats/03-divergence.js so our distances live on the same scale as the
// paper's published baselines.

export function jsd(p, q) {
  const support = new Set([...Object.keys(p), ...Object.keys(q)]);
  let d = 0;
  for (const x of support) {
    const px = p[x] ?? 0;
    const qx = q[x] ?? 0;
    const mx = (px + qx) / 2;
    if (px > 0) d += 0.5 * px * Math.log2(px / mx);
    if (qx > 0) d += 0.5 * qx * Math.log2(qx / mx);
  }
  return d;
}

export function countsToDist(counts) {
  let n = 0;
  for (const k in counts) n += counts[k];
  if (n === 0) return null;
  const p = {};
  for (const k in counts) p[k] = counts[k] / n;
  return { dist: p, n };
}
