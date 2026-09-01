// Fingerprint comparison + verdict logic.
// Scale anchors come from the paper (arXiv:2607.10252):
//   ~0.14  split-half noise floor, same model same serving stack
//   ~0.227 median distance, same model across different providers
//   ~0.463 median impostor (different model) distance
import { jsd } from './jsd.js';

export const THRESHOLDS = { MATCH_MAX: 0.25, UNCERTAIN_MAX: 0.35 };
const PROBE_MIN_CELL_N = 5;   // paper split-half minimum samples per cell half
const REF_MIN_CELL_N = 10;    // paper MIN_N for reference cells
const MIN_USABLE_CELLS = 8;   // below this the mean JSD is too thin to judge

// Verdict on an audit fingerprint vs the reference database.
export function analyze({ fingerprint, refDb, context, claimedModel }) {
  const resolved = resolveClaimed(claimedModel, Object.keys(refDb.models));

  // Distance from probe to every reference model.
  const ranking = [];
  for (const [id, entry] of Object.entries(refDb.models)) {
    let sum = 0;
    let used = 0;
    for (const [cellKey, probeCell] of Object.entries(fingerprint)) {
      if (probeCell.n < PROBE_MIN_CELL_N) continue;
      const refCell = entry.cells[cellKey];
      if (!refCell || refCell.n < REF_MIN_CELL_N) continue;
      sum += jsd(probeCell.p, refCell.p);
      used++;
    }
    if (used > 0) {
      ranking.push({
        model: id,
        family: entry.family,
        jsd: sum / used,
        usableCells: used,
        lowCoverage: used < MIN_USABLE_CELLS,
      });
    }
  }
  ranking.sort((a, b) => a.jsd - b.jsd);

  const fullCoverage = ranking.filter((r) => !r.lowCoverage);
  const topPool = fullCoverage.length ? fullCoverage : ranking;
  if (context) {
    for (const r of topPool) r.percentile = percentileBelow(context.distances, r.jsd);
  }
  const topList = topPool.slice(0, 10);

  const totalValid = Object.values(fingerprint).reduce((s, c) => s + c.n, 0);
  const usableProbeCells = Object.values(fingerprint).filter((c) => c.n >= PROBE_MIN_CELL_N).length;

  const out = {
    claimed: {
      input: claimedModel,
      resolvedId: resolved.id,
      resolution: resolved.how, // exact | alias | none
      inReferenceDb: Boolean(resolved.id),
    },
    dataQuality: {
      totalValidAnswers: totalValid,
      usableCells: usableProbeCells,
      sufficient: usableProbeCells >= MIN_USABLE_CELLS && totalValid >= 60,
    },
    top: topList,
  };

  if (!out.dataQuality.sufficient) {
    out.verdict = {
      level: 'insufficient-data',
      label: '样本不足',
      detail: `有效答案过少（${totalValid} 个有效答案 / ${usableProbeCells} 个可用维度）。判定不可靠，请提高重复次数或检查端点报错。`,
    };
    return out;
  }

  if (!resolved.id) {
    const best = topList[0];
    out.verdict = {
      level: 'no-reference',
      label: '参考库中无此型号',
      detail: `“${claimedModel}”不在 165 个参考模型中，无法做同型号验证。下方是行为上最接近的已知模型排行（当前最近：${best.model}，平均 JSD ${best.jsd.toFixed(3)}），可据此推断其真实血统。`,
    };
    return out;
  }

  const claimedEntry = ranking.find((r) => r.model === resolved.id);
  const dClaimed = claimedEntry?.jsd ?? null;
  const dTop = topList[0];
  out.distanceToClaimed = dClaimed;
  out.claimedRank = claimedEntry ? fullCoverage.findIndex((r) => r.model === resolved.id) + 1 || ranking.indexOf(claimedEntry) + 1 : null;

  if (dClaimed == null) {
    out.verdict = {
      level: 'no-reference',
      label: '参考库中无此型号',
      detail: '该型号在参考库中没有足够的可用维度，无法直接比对。',
    };
    return out;
  }

  const pct = context ? percentileBelow(context.distances, dClaimed) : null;
  out.percentileOfClaimed = pct;

  // Substitution suspicion: behaves like another known model and clearly not
  // like the claimed one.
  const substitutionSuspected =
    dClaimed > THRESHOLDS.UNCERTAIN_MAX &&
    dTop.model !== resolved.id &&
    dTop.jsd <= 0.22 &&
    (dClaimed - dTop.jsd) >= 0.08;

  let level;
  let label;
  let detail;
  if (substitutionSuspected) {
    level = 'mismatch';
    label = '高概率注水';
    detail =
      `行为指纹与「${dTop.model}」高度一致（JSD ${dTop.jsd.toFixed(3)}），而与声称的「${resolved.id}」相距甚远（JSD ${dClaimed.toFixed(3)}）。` +
      `该端点极有可能在用其它模型冒充 ${resolved.id}。`;
  } else if (dClaimed <= THRESHOLDS.MATCH_MAX) {
    level = 'match';
    label = '与声称型号相符';
    detail = `平均 JSD ${dClaimed.toFixed(3)} ≤ 0.25（跨服务商同模型的正常波动范围），未发现注水证据。` +
      (dTop.model !== resolved.id && dTop.jsd < dClaimed - 0.02
        ? `注意：${dTop.model} 在分布上略更接近（${dTop.jsd.toFixed(3)}），两者本身行为相近，不足以判异。`
        : '');
  } else if (dClaimed <= THRESHOLDS.UNCERTAIN_MAX) {
    level = 'uncertain';
    label = '存疑';
    detail = `平均 JSD ${dClaimed.toFixed(3)} 落在灰区（0.25–0.35）：可能只是换了个上游部署/量化版本，也可能是轻量替换。建议用「严格」档复测，并参考最像模型排行。`;
  } else {
    level = 'mismatch';
    label = '高概率不符';
    detail = `平均 JSD ${dClaimed.toFixed(3)} > 0.35，超过绝大多数“不同模型对”的距离下限——声称型号的行为学解释不成立。请结合最像模型排行判断真实身份。`;
  }
  out.verdict = { level, label, detail };
  return out;
}

// Fraction of impostor pair distances strictly below d ("closer than X% of
// genuinely different model pairs").
export function percentileBelow(sortedDistances, d) {
  if (!sortedDistances?.length) return null;
  let lo = 0;
  let hi = sortedDistances.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDistances[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedDistances.length;
}

// Map a user-supplied model name to a reference DB id.
export function resolveClaimed(name, dbModels) {
  const bare = String(name).trim().toLowerCase().replace(/\s+/g, '');
  const stripVariant = (s) => s.replace(/:[a-z0-9-]+$/g, ''); // ":free", ":extended"...
  const b1 = stripVariant(bare);

  for (const id of dbModels) if (id.toLowerCase() === bare) return { id, how: 'exact' };
  for (const id of dbModels) if (id.toLowerCase() === b1) return { id, how: 'alias' };

  const tailOf = (id) => id.split('/').pop().toLowerCase();
  const tailMatches = dbModels.filter((id) => tailOf(id) === b1 || tailOf(id) === bare);
  if (tailMatches.length === 1) return { id: tailMatches[0], how: tailMatches[0].toLowerCase() === b1 ? 'alias' : 'alias' };
  if (tailMatches.length > 1) {
    // prefer the undated variant (no trailing -YYYY-MM-DD)
    const undated = tailMatches.find((id) => !/\d{4}-\d{2}-\d{2}$/.test(id));
    if (undated) return { id: undated, how: 'alias' };
  }

  // last resort: relay names like "gpt-4o-mini-2024-07-18" when DB has both dated & undated
  const prefixMatches = dbModels.filter(
    (id) => tailOf(id).startsWith(b1) || tailOf(id).startsWith(bare)
  );
  const undatedOnly = prefixMatches.filter((id) => !/\d{4}-\d{2}-\d{2}$/.test(tailOf(id)));
  const pool2 = undatedOnly.length ? undatedOnly : prefixMatches;
  if (pool2.length === 1) return { id: pool2[0], how: 'alias' };

  return { id: null, how: 'none' };
}
