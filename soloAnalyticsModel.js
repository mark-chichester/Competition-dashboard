/**
 * Solo & non-solo analytics: expected score model (pure functions, no DOM).
 *
 * Separate pipelines: computeExpectedSolo vs computeExpectedGroup.
 * Recency-weighted, competition-mean-normalized baselines; panel / judging / subscore features;
 * optional global bias pass (capped, time-segmented); slice-mean calibration; peer-relative age shift;
 * REALISTIC_POST_V2 (piecewise compress at 290, mean blend, tail damp at 293, age-cohort blend,
 * baseline guardrail ±4, elite bump, hard bounds 277–297.5) — tuned for Elite Feet–style score bands.
 *
 * Temporal rule: peer pools and history use only rows on or before the entry row’s event date.
 * The entry row is excluded from its own peer pools and from leave-one-out event means.
 */
(function (global) {
  var AGE_KEYS = ["Age", "age", "Age Group", "Dancer Age"];
  var TECH_KEYS = ["Avg. Technique", "AVG. Technique", "Avg Technique"];
  var CHOREO_KEYS = [
    "AVG. Choreo & performance",
    "Avg. Choreo & performance",
    "AVG. Choreo and performance",
    "Avg. Choreo and performance",
  ];

  /** Wider σ = age differences matter less for *which peers count* (relative age shift applied separately). */
  var GLOBAL_CATEGORY_AGE_WEIGHT_SIGMA = 1.85;
  var GLOBAL_CATEGORY_AGE_WEIGHT_FALLBACK = 0.42;
  var SOLO_EXPECTED_GT_MAX = 300;

  /** λ in exp(-λ · Δmonths) — reduced to limit time-range drift from overpowering the baseline. */
  var RECENCY_LAMBDA_SOLO_BASE = 0.09;
  var RECENCY_LAMBDA_GROUP_BASE = 0.06;
  var RECENCY_LAMBDA_HIST_SOLO = 0.1;
  var RECENCY_LAMBDA_HIST_GROUP = 0.055;

  /** Feature weights (tunable): solo — more choreo / volatility. */
  var SOLO_W = {
    panel: 0.94,
    tech: 0.44,
    choreo: 0.62,
    judge: 0.52,
    style: 0.38,
    hist: 0.76,
  };
  /** Group — stronger baseline / panel, damp choreography vs baseline. */
  var GROUP_W = {
    panel: 0.98,
    tech: 0.36,
    choreo: 0.34,
    judge: 0.3,
    style: 0.26,
    hist: 0.88,
  };

  /** Top-end stretch — only used in legacy finalize path when score distribution unavailable. */
  var TOP_END_THRESHOLD = 291.5;
  var TOP_END_STRETCH = 0;
  var TOP_END_EXP = 1.05;

  /** Default calibration anchor when slice mean unavailable. */
  var CALIBRATE_MEAN = 289;
  var CALIBRATE_SCALE = 0.85;

  /** Global bias correction cap (±); segmented early/late biases are capped then interpolated. */
  var BIAS_ABS_CAP = 1.5;

  /** Peer-relative age: z within same category pool, small additive shift (younger → positive). */
  var AGE_Z_K = 0.95;
  var AGE_ADJ_MAX = 2.5;
  var AGE_PEER_STD_MIN = 0.75;
  var AGE_PEER_COUNT_MIN = 3;

  /** Extra pull on 297+ after calibration (reduces 298–300 clustering). */
  var HIGH_TAIL_START = 297;
  var HIGH_TAIL_PULL = 0.4;

  /** Soft / hard floor: compress sub-min scores upward; nothing final below this. */
  var MIN_SCORE_REALISTIC = 277;
  var SOFT_FLOOR_BLEND = 0.25;

  var NOMINAL_SCORE_CAP = 300;

  var CONFIDENCE_K_SOLO = 1.38;
  var CONFIDENCE_K_GROUP = 0.88;

  /**
   * Post-pipeline calibration: compress high tail, shrink toward dataset mean, dampen runaway highs,
   * blend with age-cohort typical score, hard cap. Toggle fields for experiments (no ML).
   */
  var REALISTIC_POST_V2 = {
    enabled: true,
    compress: true,
    /** Piecewise compress: identity until knot, then slope on the excess (soft high-end). */
    compressHighSlope: 0.6,
    compressHighKnot: 290,
    meanBlendModel: 0.9,
    meanBlendFallback: 287,
    /** If ≥2 elite signals, blend slightly more toward model so regression-to-mean doesn’t crush elites. */
    meanBlendModelIfElite: 0.92,
    tailDampenThreshold: 293,
    tailDampenFactor: 0.88,
    hardMin: 277,
    hardMax: 297.5,
    ageCohortModelBlend: 0.7,
    ageCohortMinN: 3,
    /** Max |expected − baseline| after compress / blend / tail / cohort (before elite bump). */
    guardrailMaxDeviation: 4,
    guardrailEnabled: true,
    /** Elite allowance — transparent OR of interpretable signals (solo or group history + judging). */
    eliteBumpEnabled: true,
    eliteBumpMin: 1.0,
    eliteBumpMax: 1.5,
    eliteHistAvgThreshold: 291.5,
    eliteHistMinNPrior: 2,
    eliteConsistencyMinNPrior: 3,
    eliteConsistencyMaxStd: 5.5,
    eliteJudgeSignalMin: 0.35,
  };

  /** Scale linear age z-shift before post-process cohort blend (reduces double counting). */
  var AGE_PEER_ADJ_DAMP = 0.55;

  /** Prior-performance delta influence scales with sample size (full weight at 5+ solos / routines). */
  var HISTORY_SHRINK_TARGET_N = 5;

  var predictionDeps = null;

  function setPredictionDeps(d) {
    predictionDeps = d && typeof d === "object" ? d : null;
  }

  function getPredictionDeps() {
    return predictionDeps || global.__soloAnalyticsPredictionDeps || null;
  }

  function norm(s) {
    return String(s || "").trim();
  }

  /**
   * Monotonic time key for ordering & as-of cuts. Compact sheet labels (Jul-25) and full dates must
   * share the same numeric scale: old code mixed yr*100+month (~2e5) with Date.m (~1e12), so any
   * ISO/long string beat every Mon-YY row — wrong "newest first" when years mixed formats.
   */
  function parseRowChronoKeyFromDateLabel(s) {
    var raw = norm(s);
    if (!raw) return null;
    var m = raw.match(/^([A-Za-z]{3})\s*[-]?\s*(\d{2})$/);
    if (m) {
      var monMap = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
      };
      var mon = monMap[m[1].toLowerCase()];
      if (mon == null) return null;
      var yr = parseInt(m[2], 10);
      if (isNaN(yr)) return null;
      if (yr < 100) yr += 2000;
      return Date.UTC(yr, mon, 15, 12, 0, 0);
    }
    var ms = Date.parse(raw);
    if (!isNaN(ms)) return ms;
    return null;
  }

  function rowChronoKey(r) {
    return parseRowChronoKeyFromDateLabel(r.Date);
  }

  function datasetAsOf(entry, fullDataset) {
    var cut = rowChronoKey(entry);
    if (cut == null) return fullDataset;
    var out = [];
    var i;
    for (i = 0; i < fullDataset.length; i++) {
      var r = fullDataset[i];
      var k = rowChronoKey(r);
      if (k == null) continue;
      if (k <= cut) out.push(r);
    }
    return out;
  }

  function histField(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = row[keys[i]];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  }

  function parseGrandTotal(row) {
    var v = row["Grand Total"];
    if (v != null && v !== "" && v !== "NA") {
      var n0 = parseFloat(String(v).replace(/,/g, ""));
      if (!isNaN(n0)) return n0;
    }
    var keys = Object.keys(row);
    var ki;
    for (ki = 0; ki < keys.length; ki++) {
      var kk = String(keys[ki] || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (kk !== "grand total") continue;
      var vv = row[keys[ki]];
      if (vv == null || vv === "" || vv === "NA") continue;
      var n = parseFloat(String(vv).replace(/,/g, ""));
      if (!isNaN(n)) return n;
    }
    return NaN;
  }

  function isSoloRow(r) {
    return norm(r.Category).toLowerCase() === "solo";
  }

  function rowCompEventKey(r) {
    var comp = norm(r.Competition);
    var date = norm(r.Date);
    if (!comp && !date) return "";
    return comp + "\t" + date;
  }

  function splitDancerNames(s) {
    if (!s) return [];
    return String(s)
      .split(",")
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
  }

  function dancerMatchesRow(name, row) {
    var names = splitDancerNames(row.Dancers || "");
    var i;
    for (i = 0; i < names.length; i++) {
      if (names[i] === name) return true;
    }
    return false;
  }

  function primaryDancerName(entry) {
    var names = splitDancerNames(entry.Dancers || "");
    return names.length ? names[0] : "";
  }

  function avgGrandTotals(rows) {
    if (!rows.length) return NaN;
    var sum = 0;
    var i;
    for (i = 0; i < rows.length; i++) {
      sum += parseGrandTotal(rows[i]);
    }
    return sum / rows.length;
  }

  function meanArr(a) {
    if (!a || !a.length) return NaN;
    var s = 0;
    var i;
    for (i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }

  function stdevSample(arr) {
    if (!arr || arr.length < 2) return 0;
    var m = meanArr(arr);
    var q = 0;
    var i;
    for (i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      q += d * d;
    }
    return Math.sqrt(q / (arr.length - 1));
  }

  function chronoDeltaMonths(a, b) {
    if (a == null || b == null) return 0;
    if (a > 1e8 && b > 1e8) {
      return Math.abs(a - b) / (1000 * 60 * 60 * 24 * 30.44);
    }
    if (a < 2000000 && b < 2000000 && a > 0 && b > 0) {
      var ya = Math.floor(a / 100);
      var ma = a % 100;
      var yb = Math.floor(b / 100);
      var mb = b % 100;
      return Math.abs((ya - yb) * 12 + (ma - mb));
    }
    return 0;
  }

  function recencyWeight(peerKey, refKey, lambda) {
    if (lambda <= 0 || refKey == null || peerKey == null) return 1;
    var d = chronoDeltaMonths(peerKey, refKey);
    return Math.exp(-lambda * d);
  }

  /** Leave-one-out event mean of Grand Total for competition+date bucket. */
  function buildCompEventStats(slice) {
    var map = Object.create(null);
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      var k = rowCompEventKey(r);
      if (!k) continue;
      var g = parseGrandTotal(r);
      if (isNaN(g)) continue;
      if (!map[k]) map[k] = { sum: 0, rows: [] };
      map[k].sum += g;
      map[k].rows.push({ row: r, gt: g });
    }
    return map;
  }

  function compMeanExcluding(stats, eventKey, excludeRow) {
    var b = stats[eventKey];
    if (!b || !b.rows.length) return NaN;
    if (b.rows.length === 1) {
      return b.rows[0].row === excludeRow ? NaN : b.rows[0].gt;
    }
    var sum = b.sum;
    var cnt = b.rows.length;
    var j;
    for (j = 0; j < b.rows.length; j++) {
      if (b.rows[j].row === excludeRow) {
        return (sum - b.rows[j].gt) / (cnt - 1);
      }
    }
    return sum / cnt;
  }

  /**
   * Prior-timeline mean Grand Total (entry excluded, no future rows).
   * Used to re-scale normalized peer deviations when the entry’s competition bucket has no LOO mean.
   */
  function sliceGrandMeanGT(slice, excludeRow) {
    var s = 0;
    var n = 0;
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === excludeRow) continue;
      var g = parseGrandTotal(r);
      if (isNaN(g)) continue;
      s += g;
      n++;
    }
    return n ? s / n : NaN;
  }

  /** Mean Grand Total over all scored rows (for regression-to-mean blend). */
  function computeDatasetGrandMeanGT(dataset) {
    if (!dataset || !dataset.length) return NaN;
    var s = 0;
    var n = 0;
    var i;
    for (i = 0; i < dataset.length; i++) {
      var g = parseGrandTotal(dataset[i]);
      if (isNaN(g)) continue;
      s += g;
      n++;
    }
    return n ? s / n : NaN;
  }

  /** Implausible normalized baseline (missing event anchor used to add 0). */
  var IMPLAUSIBLE_BASELINE_MAX = 120;
  var CATASTROPHIC_EXPECTED_MAX = 115;
  var MIN_RESCALE_SLICE_MEAN = 165;

  var _debugDanceNameSet = Object.create(null);

  function setDebugDanceNames(names) {
    _debugDanceNameSet = Object.create(null);
    if (!names || !names.length) return;
    var i;
    for (i = 0; i < names.length; i++) {
      _debugDanceNameSet[norm(names[i])] = true;
    }
  }

  function shouldDebugEntry(entry) {
    return !!_debugDanceNameSet[norm(entry["Dance Name"])];
  }

  function debugLog(entry, label, payload) {
    if (!global.console || !shouldDebugEntry(entry)) return;
    global.console.log(label, payload);
  }

  function parseAgeNumericMidpoint(raw) {
    var s = norm(raw);
    if (!s) return null;
    var lower = s.toLowerCase();

    var rangeM = s.match(/^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/);
    if (rangeM) {
      var a = parseInt(rangeM[1], 10);
      var b = parseInt(rangeM[2], 10);
      if (!isNaN(a) && !isNaN(b)) return (Math.min(a, b) + Math.max(a, b)) / 2;
    }

    if (/\bunder\b/.test(lower) || /^u\s*\d/.test(lower) || /^u\d/.test(lower)) {
      var um = s.match(/(\d{1,2})/);
      if (um) {
        var cap = parseInt(um[1], 10);
        if (!isNaN(cap)) return cap - 0.5;
      }
    }

    if (/\bover\b/.test(lower) || /^o\s*\d/.test(lower) || /^o\d/.test(lower)) {
      var om = s.match(/(\d{1,2})/);
      if (om) {
        var fl = parseInt(om[1], 10);
        if (!isNaN(fl)) return fl + 0.5;
      }
    }

    if (/\d{1,2}\s*\+$/.test(lower)) {
      var pm = s.match(/^(\d{1,2})/);
      if (pm) {
        var p = parseInt(pm[1], 10);
        if (!isNaN(p)) return p + 0.5;
      }
    }

    var single = s.match(/^(\d{1,2})$/);
    if (single) {
      var one = parseInt(single[1], 10);
      if (!isNaN(one)) return one;
    }

    var lead = s.match(/^(\d{1,2})\b/);
    if (lead) {
      var L = parseInt(lead[1], 10);
      if (!isNaN(L)) return L;
    }

    return null;
  }

  function globalCategoryAgePeerWeight(entryAgeStr, entryAgeNum, peerRow) {
    var peerAgeStr = histField(peerRow, AGE_KEYS);
    var peerAgeNum = parseAgeNumericMidpoint(peerAgeStr);
    var sigma = GLOBAL_CATEGORY_AGE_WEIGHT_SIGMA;
    var fallback = GLOBAL_CATEGORY_AGE_WEIGHT_FALLBACK;

    if (entryAgeNum != null && peerAgeNum != null) {
      var d = peerAgeNum - entryAgeNum;
      return Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    var es = norm(entryAgeStr);
    var ps = norm(peerAgeStr);
    if (es && ps && es === ps) return 1;
    if (!es) return 1;
    return fallback;
  }

  /** Numeric ages of scored same-category peers (prior timeline), entry excluded. */
  function categoryPeerNumericAges(slice, entry, catEntry) {
    var nums = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (norm(r.Category) !== catEntry) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      var a = parseAgeNumericMidpoint(histField(r, AGE_KEYS));
      if (a != null && !isNaN(a)) nums.push(a);
    }
    return nums;
  }

  /**
   * Additive shift from age z vs category peers (does not rescale baseline via weights only).
   * Younger than peer mean → positive adjustment; older → negative. Bounded in ±AGE_ADJ_MAX.
   */
  function agePeerRelativeAdjustment(entry, slice) {
    var catEntry = norm(entry.Category);
    var peerAges = categoryPeerNumericAges(slice, entry, catEntry);
    if (peerAges.length < AGE_PEER_COUNT_MIN) return 0;
    var m = meanArr(peerAges);
    var sd = stdevSample(peerAges);
    if (!sd || sd < AGE_PEER_STD_MIN) return 0;
    var entryAge = parseAgeNumericMidpoint(histField(entry, AGE_KEYS));
    if (entryAge == null || isNaN(entryAge)) return 0;
    var z = (entryAge - m) / sd;
    var adj = -AGE_Z_K * z;
    if (adj > AGE_ADJ_MAX) adj = AGE_ADJ_MAX;
    if (adj < -AGE_ADJ_MAX) adj = -AGE_ADJ_MAX;
    return adj * AGE_PEER_ADJ_DAMP;
  }

  /**
   * Typical realized Grand Total in this dancer’s Level + Age + Category cohort (prior rows only).
   * Used to anchor predictions to peer-relative norms and reduce systematic age bias.
   */
  function ageGroupCohortMeanGT(entry, slice) {
    var level = norm(entry.Level);
    var age = histField(entry, AGE_KEYS);
    var cat = norm(entry.Category);
    if (!cat) return { mean: NaN, n: 0 };
    var gts = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (norm(r.Category) !== cat) continue;
      if (norm(r.Level) !== level) continue;
      if (histField(r, AGE_KEYS) !== age) continue;
      var g = parseGrandTotal(r);
      if (!isNaN(g)) gts.push(g);
    }
    return { mean: meanArr(gts), n: gts.length };
  }

  function capBias(b) {
    var c = BIAS_ABS_CAP;
    if (b == null || isNaN(b)) return 0;
    if (b > c) return c;
    if (b < -c) return -c;
    return b;
  }

  function weightedNormalizedPool(
    pool,
    entry,
    compStats,
    recLambda,
    useAgeKernel,
    entryAgeStr,
    entryAgeNum,
    anchorFallback,
  ) {
    var entryKey = rowChronoKey(entry);
    var entryEv = rowCompEventKey(entry);
    var baseMean = compMeanExcluding(compStats, entryEv, entry);

    var anchor =
      !isNaN(baseMean) ? baseMean : !isNaN(anchorFallback) ? anchorFallback : NaN;

    var wSum = 0;
    var nSum = 0;
    var w2Sum = 0;
    var i;
    for (i = 0; i < pool.length; i++) {
      var r = pool[i];
      var g = parseGrandTotal(r);
      if (isNaN(g)) continue;
      var rev = rowCompEventKey(r);
      var cm = compMeanExcluding(compStats, rev, r);
      if (isNaN(cm)) {
        if (!isNaN(baseMean)) cm = baseMean;
        else if (!isNaN(anchorFallback)) cm = anchorFallback;
        else continue;
      }
      var normScore = g - cm;
      var wR = recencyWeight(rowChronoKey(r), entryKey, recLambda);
      var wA = useAgeKernel ? globalCategoryAgePeerWeight(entryAgeStr, entryAgeNum, r) : 1;
      var w = wR * wA;
      if (w <= 0 || isNaN(w)) continue;
      wSum += w;
      w2Sum += w * w;
      nSum += w * normScore;
    }
    if (wSum <= 0) {
      var rawOnly = pool.length ? avgGrandTotals(pool) : NaN;
      if (!isNaN(rawOnly)) {
        return { baseline: rawOnly, n: pool.length, nEffective: pool.length };
      }
      return { baseline: NaN, n: pool.length, nEffective: 0 };
    }
    var baselineNorm = nSum / wSum;
    if (isNaN(anchor)) {
      var rawFallback = avgGrandTotals(pool);
      if (!isNaN(rawFallback)) {
        anchor = rawFallback;
      }
    }
    if (isNaN(anchor)) {
      return { baseline: NaN, n: pool.length, nEffective: 0 };
    }
    var baseline = baselineNorm + anchor;
    var nEff = w2Sum > 0 ? (wSum * wSum) / w2Sum : pool.length;
    debugLog(entry, "[SoloAnalyticsModel] weightedNormalizedPool", {
      poolSize: pool.length,
      baseMeanEvent: baseMean,
      anchorFallback: anchorFallback,
      anchorUsed: anchor,
      baselineNorm: baselineNorm,
      baseline: baseline,
    });
    return { baseline: baseline, n: pool.length, nEffective: nEff };
  }

  function getContextBaseline(entry, dataset, compStats, isGroup) {
    var slice = datasetAsOf(entry, dataset);
    if (!compStats) compStats = buildCompEventStats(slice);
    var recLambda = isGroup ? RECENCY_LAMBDA_GROUP_BASE : RECENCY_LAMBDA_SOLO_BASE;

    var level = norm(entry.Level);
    var age = histField(entry, AGE_KEYS);
    var style = norm(entry.Style);
    var catEntry = norm(entry.Category);
    var gAgeStr = histField(entry, AGE_KEYS);
    var gAgeNum = parseAgeNumericMidpoint(gAgeStr);
    var useKernel = !!(norm(gAgeStr) || gAgeNum != null);

    function pool(filterFn) {
      var out = [];
      var i;
      for (i = 0; i < slice.length; i++) {
        var r = slice[i];
        if (r === entry) continue;
        if (norm(r.Category) !== catEntry) continue;
        if (isNaN(parseGrandTotal(r))) continue;
        if (!filterFn(r)) continue;
        out.push(r);
      }
      return out;
    }

    var sliceAnchor = sliceGrandMeanGT(slice, entry);

    function tierResult(p, tier, forceKernel) {
      if (!p.length) return null;
      var uK = forceKernel != null ? forceKernel : useKernel && tier === "global_category";
      var w = weightedNormalizedPool(
        p,
        entry,
        compStats,
        recLambda,
        uK,
        gAgeStr,
        gAgeNum,
        sliceAnchor,
      );
      if (isNaN(w.baseline)) return null;
      if (w.baseline < IMPLAUSIBLE_BASELINE_MAX && !isNaN(sliceAnchor) && sliceAnchor >= MIN_RESCALE_SLICE_MEAN) {
        w.baseline = Math.max(w.baseline, sliceAnchor);
      }
      return {
        baseline: w.baseline,
        n: w.n,
        nEffective: w.nEffective > 0 ? w.nEffective : w.n,
        tier: tier,
      };
    }

    var p0 = pool(function (r) {
      return norm(r.Level) === level && histField(r, AGE_KEYS) === age && norm(r.Style) === style;
    });
    if (p0.length >= 5) {
      var t0 = tierResult(p0, "level_age_style", false);
      if (t0) return t0;
    }

    var p1 = pool(function (r) {
      return norm(r.Level) === level && histField(r, AGE_KEYS) === age;
    });
    if (p1.length >= 5) {
      var t1 = tierResult(p1, "level_age", false);
      if (t1) return t1;
    }

    var p2 = pool(function (r) {
      return norm(r.Level) === level;
    });
    if (p2.length >= 5) {
      var t2 = tierResult(p2, "level", false);
      if (t2) return t2;
    }

    var p3 = pool(function () {
      return true;
    });
    if (p3.length) {
      if (!norm(gAgeStr) && gAgeNum == null) {
        var w3 = tierResult(p3, "global_category", false);
        if (w3) return w3;
        return { baseline: avgGrandTotals(p3), n: p3.length, tier: "global_category" };
      }
      var wtd = weightedNormalizedPool(p3, entry, compStats, recLambda, true, gAgeStr, gAgeNum, sliceAnchor);
      if (!isNaN(wtd.baseline) && wtd.nEffective > 0) {
        if (
          wtd.baseline < IMPLAUSIBLE_BASELINE_MAX &&
          !isNaN(sliceAnchor) &&
          sliceAnchor >= MIN_RESCALE_SLICE_MEAN
        ) {
          wtd.baseline = Math.max(wtd.baseline, sliceAnchor);
        }
        return {
          baseline: wtd.baseline,
          n: p3.length,
          nEffective: wtd.nEffective,
          tier: "global_category",
        };
      }
      return { baseline: avgGrandTotals(p3), n: p3.length, tier: "global_category" };
    }
    return { baseline: NaN, n: 0, tier: "none" };
  }

  function getPanelAdjustment(entry, dataset, compStats) {
    var slice = datasetAsOf(entry, dataset);
    if (!compStats) compStats = buildCompEventStats(slice);
    var ev = rowCompEventKey(entry);
    var compSum = 0;
    var compN = 0;
    var globSum = 0;
    var globN = 0;
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      var g = parseGrandTotal(r);
      if (isNaN(g)) continue;
      globSum += g;
      globN++;
      if (ev && rowCompEventKey(r) === ev) {
        compSum += g;
        compN++;
      }
    }
    var compAvg = compN ? compSum / compN : NaN;
    var globAvg = globN ? globSum / globN : NaN;
    if (isNaN(compAvg) || isNaN(globAvg)) return 0;
    return compAvg - globAvg;
  }

  /** Same-event style vs full-event mean (prior peers only; excludes entry). */
  function eventStyleDeltaGT(entry, slice) {
    var ev = rowCompEventKey(entry);
    if (!ev) return 0;
    var myStyle = norm(entry.Style);
    var allG = [];
    var styleG = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (rowCompEventKey(r) !== ev) continue;
      var g = parseGrandTotal(r);
      if (isNaN(g)) continue;
      allG.push(g);
      if (norm(r.Style) === myStyle) styleG.push(g);
    }
    if (styleG.length < 2 || allG.length < 4) return 0;
    return meanArr(styleG) - meanArr(allG);
  }

  function eventJudgePanelAdjustment(entry, slice) {
    var deps = getPredictionDeps();
    if (!deps || typeof deps.extractEliteFeetJudgeBreakdown !== "function") return 0;
    var ev = rowCompEventKey(entry);
    if (!ev) return 0;
    var my = deps.extractEliteFeetJudgeBreakdown(entry);
    var nJ = Math.min(my.technique.length, my.choreo.length);
    if (!nJ) return 0;
    var biasSum = 0;
    var biasN = 0;
    var j;
    for (j = 0; j < nJ; j++) {
      var poolTc = [];
      var i;
      for (i = 0; i < slice.length; i++) {
        var r = slice[i];
        if (r === entry) continue;
        if (rowCompEventKey(r) !== ev) continue;
        var er = deps.extractEliteFeetJudgeBreakdown(r);
        if (j >= er.technique.length || j >= er.choreo.length) continue;
        var t0 = er.technique[j].value;
        var c0 = er.choreo[j].value;
        if (isNaN(t0) || isNaN(c0)) continue;
        poolTc.push(t0 + c0);
      }
      if (poolTc.length < 2) continue;
      var m = meanArr(poolTc);
      var mt = my.technique[j].value;
      var mc = my.choreo[j].value;
      if (isNaN(mt) || isNaN(mc)) continue;
      biasSum += mt + mc - m;
      biasN++;
    }
    if (!biasN) return 0;
    return (biasSum / biasN) * 0.58;
  }

  function subscoreMarginalGT(entry, slice, techK, choreoK) {
    var deps = getPredictionDeps();
    if (!deps || typeof deps.rowFirstNumeric !== "function") {
      return { tech: 0, choreo: 0 };
    }
    var ev = rowCompEventKey(entry);
    if (!ev) return { tech: 0, choreo: 0 };
    var techs = [];
    var chos = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (rowCompEventKey(r) !== ev) continue;
      var tC = deps.rowFirstNumeric(r, TECH_KEYS);
      var cC = deps.rowFirstNumeric(r, CHOREO_KEYS);
      if (tC && !isNaN(tC.value)) techs.push(tC.value);
      if (cC && !isNaN(cC.value)) chos.push(cC.value);
    }
    var mt = techs.length ? meanArr(techs) : NaN;
    var mc = chos.length ? meanArr(chos) : NaN;
    var et = deps.rowFirstNumeric(entry, TECH_KEYS);
    var ec = deps.rowFirstNumeric(entry, CHOREO_KEYS);
    var tDev =
      et && !isNaN(et.value) && !isNaN(mt) ? (et.value - mt) * techK : 0;
    var cDev =
      ec && !isNaN(ec.value) && !isNaN(mc) ? (ec.value - mc) * choreoK : 0;
    return { tech: tDev, choreo: cDev };
  }

  function rowRoutineKey(r) {
    return norm(r.Category) + "\t" + norm(r["Dance Name"]);
  }

  function routineMatchesEntry(entry, r) {
    return rowRoutineKey(r) === rowRoutineKey(entry);
  }

  function countPriorSolosForDancer(entry, dataset) {
    var dancer = primaryDancerName(entry);
    if (!dancer) return 0;
    var slice = datasetAsOf(entry, dataset);
    var n = 0;
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!isSoloRow(r)) continue;
      if (!dancerMatchesRow(dancer, r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      n++;
    }
    return n;
  }

  function getDancerWeight(entry, dataset) {
    var n = countPriorSolosForDancer(entry, dataset);
    if (n <= 2) return 0.28;
    if (n <= 5) return 0.52;
    return 1;
  }

  function countPriorDancePerformances(entry, dataset) {
    var slice = datasetAsOf(entry, dataset);
    var n = 0;
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!routineMatchesEntry(entry, r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      n++;
    }
    return n;
  }

  function getDanceWeight(entry, dataset) {
    var n = countPriorDancePerformances(entry, dataset);
    if (n <= 2) return 0.3;
    if (n <= 5) return 0.55;
    return 1;
  }

  function getDancerDeltaWeighted(entry, dataset, isGroupBaselineForPeer) {
    var dancer = primaryDancerName(entry);
    if (!dancer) {
      return {
        delta: 0,
        actualAvg: NaN,
        expectedAvg: NaN,
        nPast: 0,
        nEff: 0,
        unweightedDelta: 0,
      };
    }
    var slice = datasetAsOf(entry, dataset);
    var past = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!isSoloRow(r)) continue;
      if (!dancerMatchesRow(dancer, r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      past.push(r);
    }
    if (!past.length) {
      return {
        delta: 0,
        actualAvg: NaN,
        expectedAvg: NaN,
        nPast: 0,
        nEff: 0,
        unweightedDelta: 0,
      };
    }
    var entryKey = rowChronoKey(entry);
    var lam = RECENCY_LAMBDA_HIST_SOLO;
    var wSum = 0;
    var w2 = 0;
    var rSum = 0;
    var actSum = 0;
    var expSum = 0;
    var expN = 0;
    var j;
    for (j = 0; j < past.length; j++) {
      var p = past[j];
      var act = parseGrandTotal(p);
      actSum += act;
      var sliceP = datasetAsOf(p, dataset);
      var statsP = buildCompEventStats(sliceP);
      var b = getContextBaseline(p, dataset, statsP, isGroupBaselineForPeer);
      var pan = getPanelAdjustment(p, dataset, statsP);
      var w = recencyWeight(rowChronoKey(p), entryKey, lam);
      if (!isNaN(act) && !isNaN(b.baseline)) {
        var resid = act - b.baseline - pan;
        wSum += w;
        w2 += w * w;
        rSum += w * resid;
        expSum += b.baseline + pan;
        expN++;
      }
    }
    var actualAvg = actSum / past.length;
    var delta = wSum > 0 ? rSum / wSum : 0;
    var unweighted = 0;
    if (expN) {
      var acts = [];
      for (var q = 0; q < past.length; q++) {
        var gg = parseGrandTotal(past[q]);
        if (!isNaN(gg)) acts.push(gg);
      }
      if (acts.length) unweighted = meanArr(acts) - expSum / expN;
    }
    if (isNaN(unweighted)) unweighted = 0;
    var nEff = w2 > 0 ? (wSum * wSum) / w2 : past.length;
    var expectedAvg = expN ? expSum / expN : NaN;
    return {
      delta: delta,
      actualAvg: actualAvg,
      expectedAvg: expectedAvg,
      nPast: past.length,
      nEff: nEff,
      unweightedDelta: unweighted,
    };
  }

  function getDanceDeltaWeighted(entry, dataset) {
    var slice = datasetAsOf(entry, dataset);
    var past = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!routineMatchesEntry(entry, r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      past.push(r);
    }
    if (!past.length) {
      return {
        delta: 0,
        actualAvg: NaN,
        expectedAvg: NaN,
        nPast: 0,
        nEff: 0,
        unweightedDelta: 0,
      };
    }
    var entryKey = rowChronoKey(entry);
    var lam = RECENCY_LAMBDA_HIST_GROUP;
    var wSum = 0;
    var w2 = 0;
    var rSum = 0;
    var actSum = 0;
    var expSum = 0;
    var expN = 0;
    var j;
    for (j = 0; j < past.length; j++) {
      var p = past[j];
      var act = parseGrandTotal(p);
      actSum += act;
      var sliceP = datasetAsOf(p, dataset);
      var statsP = buildCompEventStats(sliceP);
      var b = getContextBaseline(p, dataset, statsP, true);
      var pan = getPanelAdjustment(p, dataset, statsP);
      var w = recencyWeight(rowChronoKey(p), entryKey, lam);
      if (!isNaN(act) && !isNaN(b.baseline)) {
        var resid = act - b.baseline - pan;
        wSum += w;
        w2 += w * w;
        rSum += w * resid;
        expSum += b.baseline + pan;
        expN++;
      }
    }
    var gts = [];
    for (j = 0; j < past.length; j++) {
      var g0 = parseGrandTotal(past[j]);
      if (!isNaN(g0)) gts.push(g0);
    }
    var actualAvg = gts.length ? meanArr(gts) : NaN;
    var delta = wSum > 0 ? rSum / wSum : 0;
    var nEff = w2 > 0 ? (wSum * wSum) / w2 : past.length;
    var expectedAvg = expN ? expSum / expN : NaN;
    return {
      delta: delta,
      actualAvg: actualAvg,
      expectedAvg: expectedAvg,
      nPast: past.length,
      nEff: nEff,
      unweightedDelta: expN && !isNaN(actualAvg) ? actualAvg - expectedAvg : 0,
    };
  }

  function soloBreakoutBoost(entry, dataset) {
    var dancer = primaryDancerName(entry);
    if (!dancer) return 0;
    var slice = datasetAsOf(entry, dataset);
    var past = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!isSoloRow(r)) continue;
      if (!dancerMatchesRow(dancer, r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      past.push(r);
    }
    if (past.length < 3) return 0;
    past.sort(function (a, b) {
      var ka = rowChronoKey(a);
      var kb = rowChronoKey(b);
      if (ka == null) return 1;
      if (kb == null) return -1;
      return ka - kb;
    });
    var last3 = past.slice(-3);
    var g = last3.map(parseGrandTotal);
    if (g.length < 3) return 0;
    if (g[0] < g[1] && g[1] < g[2]) {
      var slope = (g[2] - g[0]) / 2;
      return Math.min(5.8, 0.48 * slope);
    }
    if (g[2] >= g[1] && g[1] > g[0]) {
      return Math.min(3.2, 0.28 * (g[2] - g[0]));
    }
    return 0;
  }

  function groupStructuralCalibration(entry) {
    var n = splitDancerNames(entry.Dancers || "").length;
    if (n <= 1) return 0;
    if (n >= 6) return 0.95;
    if (n >= 4) return 0.65;
    if (n >= 3) return 0.42;
    return 0.22;
  }

  function groupHistoryStabilityDampen(pastGts, rawDelta) {
    if (pastGts.length < 3) return rawDelta;
    var sd = stdevSample(pastGts);
    if (sd > 14) return rawDelta * 0.8;
    if (sd > 9) return rawDelta * 0.9;
    return rawDelta;
  }

  function soloPriorGtStd(entry, dataset) {
    var dancer = primaryDancerName(entry);
    if (!dancer) return 0;
    var slice = datasetAsOf(entry, dataset);
    var arr = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!isSoloRow(r)) continue;
      if (!dancerMatchesRow(dancer, r)) continue;
      var g = parseGrandTotal(r);
      if (!isNaN(g)) arr.push(g);
    }
    return stdevSample(arr);
  }

  function groupPriorGtStd(entry, dataset) {
    var slice = datasetAsOf(entry, dataset);
    var arr = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!routineMatchesEntry(entry, r)) continue;
      var g = parseGrandTotal(r);
      if (!isNaN(g)) arr.push(g);
    }
    return stdevSample(arr);
  }

  function soloVolatilityBoost(stdPast, nPast) {
    if (nPast < 4 || stdPast < 13.5) return 0;
    return Math.min(3.4, 0.11 * stdPast);
  }

  function applyTopEndStretch(x) {
    if (isNaN(x)) return x;
    var t = TOP_END_THRESHOLD;
    if (x <= t) return x;
    var e = x - t;
    return x + TOP_END_STRETCH * Math.pow(e, TOP_END_EXP);
  }

  function calibrateScore(x, mean) {
    if (isNaN(x)) return x;
    var mu =
      mean != null && !isNaN(mean) && mean >= MIN_RESCALE_SLICE_MEAN - 20 ? mean : CALIBRATE_MEAN;
    var scale = CALIBRATE_SCALE;
    return mu + scale * (x - mu);
  }

  function highTailCompress(x) {
    if (isNaN(x) || x <= HIGH_TAIL_START) return x;
    return x - HIGH_TAIL_PULL * (x - HIGH_TAIL_START);
  }

  /** Soft high-end compression: flat ≤ knot, then gentler slope above (preserves spread vs old curve). */
  function compressScore(x, opts) {
    if (isNaN(x)) return x;
    var C = REALISTIC_POST_V2;
    var knot = opts && opts.knot != null ? opts.knot : C.compressHighKnot;
    var slope = opts && opts.slope != null ? opts.slope : C.compressHighSlope;
    if (x <= knot) return x;
    return knot + (x - knot) * slope;
  }

  /**
   * Elite routine bump from observable signals only (no ML).
   * Signals: strong prior scored average, consistent prior highs, generous panel + subscore day.
   */
  function computeElitePerformanceBump(postCtx) {
    if (!REALISTIC_POST_V2.eliteBumpEnabled || !postCtx) {
      return { bump: 0, eliteSignalCount: 0 };
    }
    var C = REALISTIC_POST_V2;
    var nPrior = postCtx.ddNPast || 0;
    var histAvg = postCtx.ddActualAvg;
    var stdPast = postCtx.stdPast;
    var sig = 0;
    if (
      nPrior >= C.eliteHistMinNPrior &&
      !isNaN(histAvg) &&
      histAvg > C.eliteHistAvgThreshold
    ) {
      sig++;
    }
    if (
      nPrior >= C.eliteConsistencyMinNPrior &&
      !isNaN(stdPast) &&
      stdPast < C.eliteConsistencyMaxStd &&
      !isNaN(histAvg) &&
      histAvg > C.eliteHistAvgThreshold - 1
    ) {
      sig++;
    }
    var judgeCombo =
      (postCtx.panelAdjustment || 0) +
      (postCtx.judgingAdjustment || 0) +
      0.5 * (postCtx.subTech || 0) +
      0.5 * (postCtx.subChoreo || 0);
    if (judgeCombo > C.eliteJudgeSignalMin) sig++;
    if (sig === 0) return { bump: 0, eliteSignalCount: 0 };
    var bLo = C.eliteBumpMin;
    var bHi = C.eliteBumpMax;
    if (sig >= 3) return { bump: bHi, eliteSignalCount: sig };
    if (sig === 2) return { bump: (bLo + bHi) / 2, eliteSignalCount: sig };
    return { bump: bLo, eliteSignalCount: sig };
  }

  function applyDeviationGuardrail(expected, baseline, maxDev) {
    if (isNaN(expected) || isNaN(baseline) || maxDev == null || maxDev <= 0) return expected;
    var d = expected - baseline;
    if (Math.abs(d) <= maxDev) return expected;
    return baseline + (d > 0 ? maxDev : -maxDev);
  }

  function applyRealisticPostProcess(expected, entry, slice, dataset, calMean, datasetGrandMean, postCtx) {
    if (!REALISTIC_POST_V2.enabled || isNaN(expected)) return expected;
    var C = REALISTIC_POST_V2;
    var eliteInfo = computeElitePerformanceBump(postCtx || {});
    var wb = C.meanBlendModel;
    if (eliteInfo.eliteSignalCount >= 2) wb = C.meanBlendModelIfElite;
    var x = expected;
    if (C.compress) {
      x = compressScore(x);
    }
    var gm = datasetGrandMean;
    if (gm == null || isNaN(gm)) {
      gm = computeDatasetGrandMeanGT(dataset);
    }
    if (isNaN(gm)) {
      gm = !isNaN(calMean) ? calMean : C.meanBlendFallback;
    }
    x = x * wb + gm * (1 - wb);
    if (x > C.tailDampenThreshold) {
      x = C.tailDampenThreshold + (x - C.tailDampenThreshold) * C.tailDampenFactor;
    }
    var cohort = ageGroupCohortMeanGT(entry, slice);
    if (cohort.n >= C.ageCohortMinN && !isNaN(cohort.mean)) {
      var ab = C.ageCohortModelBlend;
      x = x * ab + cohort.mean * (1 - ab);
    }
    if (C.guardrailEnabled && postCtx && !isNaN(postCtx.contextBaseline)) {
      x = applyDeviationGuardrail(x, postCtx.contextBaseline, C.guardrailMaxDeviation);
    }
    if (C.eliteBumpEnabled && eliteInfo.bump > 0) {
      x += eliteInfo.bump;
    }
    if (x < C.hardMin) x = C.hardMin;
    if (x > C.hardMax) x = C.hardMax;
    return x;
  }

  function predictionConfidenceNumeric(stdPast, nCtx, nHist) {
    var sh = stdPast || 0;
    var maxV = 140;
    var v =
      sh * sh + 36 / Math.max(1, nHist || 1) + 25 / Math.max(1, nCtx || 1);
    var c = 1 - Math.min(1, v / maxV);
    if (c < 0) return 0;
    if (c > 1) return 1;
    return c;
  }

  /**
   * Compress scores below the realistic band toward MIN; enforce a hard floor at MIN
   * so calibrated outputs do not sit in the low 270s.
   */
  function softFloorScore(x) {
    if (isNaN(x)) return x;
    var min = MIN_SCORE_REALISTIC;
    if (x >= min) return x;
    var y = min + SOFT_FLOOR_BLEND * (x - min);
    return y < min ? min : y;
  }

  /**
   * Asymptotic cap toward NOMINAL_SCORE_CAP. Plain `cap - exp(-(cap-x))` is only sensible
   * near the ceiling; apply only for headroom ≤ 2 so mid scores are untouched.
   * For x already at/above cap, continue compressing with the same form (bounded via exp(x-cap)).
   */
  /**
   * Soft asymptotic ceiling at `max`: for headroom d in (0,2], `max - exp(-d)`; identity farther below,
   * smooth continuation for x > max. Avoids mass at exactly 300.
   */
  function softCapScore(x) {
    if (isNaN(x)) return x;
    var max = NOMINAL_SCORE_CAP;
    var d = max - x;
    if (d > 2) return x;
    if (d <= 0) return max - Math.exp(Math.min(0, d));
    return max - Math.exp(-d);
  }

  /**
   * After `preBias` (+ global bias): stretch → calibrate(mean) → high-tail compress → floor → soft cap.
   */
  function finalizeCalibratedExpected(preBias, calMean) {
    if (isNaN(preBias)) return NaN;
    var y = applyTopEndStretch(preBias);
    y = calibrateScore(y, calMean);
    y = highTailCompress(y);
    y = softFloorScore(y);
    y = softCapScore(y);
    if (y < 0) y = 0;
    return y;
  }

  function calibrationMeanOrDefault(slice, entry) {
    var m = sliceGrandMeanGT(slice, entry);
    if (!isNaN(m) && m >= MIN_RESCALE_SLICE_MEAN - 15) return m;
    return CALIBRATE_MEAN;
  }

  function chronologyT(entry, lo, hi) {
    var k = rowChronoKey(entry);
    if (k == null || lo == null || hi == null) return 0.5;
    if (hi === lo) return 0.5;
    var t = (k - lo) / (hi - lo);
    if (t < 0) return 0;
    if (t > 1) return 1;
    return t;
  }

  function effectiveSoloBias(biasBundle, entry) {
    if (!biasBundle) return 0;
    if (
      biasBundle.soloBiasEarly != null &&
      biasBundle.soloBiasLate != null &&
      biasBundle.soloChronoLo != null &&
      biasBundle.soloChronoHi != null
    ) {
      var t = chronologyT(entry, biasBundle.soloChronoLo, biasBundle.soloChronoHi);
      return capBias((1 - t) * biasBundle.soloBiasEarly + t * biasBundle.soloBiasLate);
    }
    return capBias(biasBundle.soloBias != null ? biasBundle.soloBias : 0);
  }

  function effectiveGroupBias(biasBundle, entry) {
    if (!biasBundle) return 0;
    if (
      biasBundle.groupBiasEarly != null &&
      biasBundle.groupBiasLate != null &&
      biasBundle.groupChronoLo != null &&
      biasBundle.groupChronoHi != null
    ) {
      var t = chronologyT(entry, biasBundle.groupChronoLo, biasBundle.groupChronoHi);
      return capBias((1 - t) * biasBundle.groupBiasEarly + t * biasBundle.groupBiasLate);
    }
    return capBias(biasBundle.groupBias != null ? biasBundle.groupBias : 0);
  }

  function getConfidenceLevelFromStats(stdHist, nCtx, nHist, isSolo) {
    var k = isSolo ? CONFIDENCE_K_SOLO : CONFIDENCE_K_GROUP;
    var width = k * (stdHist || 0) + 6.2 / Math.sqrt(Math.max(1, nCtx));
    var nEff = Math.min(Math.max(1, nCtx), Math.max(1, nHist || nCtx));
    if (width <= 5.1 && nEff >= 12) return "high";
    if (width <= 11.2 && nEff >= 5) return "medium";
    return "low";
  }

  function computeExpectedSolo(entry, dataset, opts) {
    opts = opts || {};
    var slice = datasetAsOf(entry, dataset);
    var compStats = opts.compStats || buildCompEventStats(slice);
    var globalBias = opts.globalBias != null ? opts.globalBias : 0;

    var ctx = getContextBaseline(entry, dataset, compStats, false);
    var base = ctx.baseline;
    if (isNaN(base)) {
      return {
        preBiasExpected: NaN,
        expected: NaN,
        actual: parseGrandTotal(entry),
        parts: {},
      };
    }

    var panel = getPanelAdjustment(entry, dataset, compStats);
    var styleAdj = eventStyleDeltaGT(entry, slice);
    var judgeAdj = eventJudgePanelAdjustment(entry, slice);
    var sub = subscoreMarginalGT(entry, slice, 0.88, 1.02);
    var dd = getDancerDeltaWeighted(entry, dataset, false);
    var histShrink = Math.min(1, Math.max(0, dd.nPast) / HISTORY_SHRINK_TARGET_N);
    var histWeighted =
      dd.delta * getDancerWeight(entry, dataset) * SOLO_W.hist * histShrink;
    var breakout = soloBreakoutBoost(entry, dataset);
    var stdPast = soloPriorGtStd(entry, dataset);
    var vol = soloVolatilityBoost(stdPast, dd.nPast);

    var sliceMeanAnch = sliceGrandMeanGT(slice, entry);
    var calMean = calibrationMeanOrDefault(slice, entry);
    var agePeerAdj = agePeerRelativeAdjustment(entry, slice);

    var pre =
      base +
      SOLO_W.panel * panel +
      SOLO_W.tech * sub.tech +
      SOLO_W.choreo * sub.choreo +
      SOLO_W.judge * judgeAdj +
      SOLO_W.style * styleAdj +
      histWeighted +
      breakout +
      vol +
      agePeerAdj;

    var preAdj = pre;
    if (
      !isNaN(base) &&
      base < IMPLAUSIBLE_BASELINE_MAX &&
      !isNaN(sliceMeanAnch) &&
      sliceMeanAnch >= MIN_RESCALE_SLICE_MEAN
    ) {
      preAdj = sliceMeanAnch + (pre - base);
    }

    var preBias = preAdj + globalBias;
    var stretchProbe = applyTopEndStretch(preBias);
    var expected = finalizeCalibratedExpected(preBias, calMean);
    if (
      !isNaN(stretchProbe) &&
      stretchProbe < CATASTROPHIC_EXPECTED_MAX &&
      !isNaN(sliceMeanAnch) &&
      sliceMeanAnch >= MIN_RESCALE_SLICE_MEAN
    ) {
      preAdj = sliceMeanAnch + SOLO_W.panel * panel + agePeerAdj;
      preBias = preAdj + globalBias;
      expected = finalizeCalibratedExpected(preBias, calMean);
    }

    expected = applyRealisticPostProcess(
      expected,
      entry,
      slice,
      dataset,
      calMean,
      opts.datasetGrandMean,
      {
        contextBaseline: base,
        panelAdjustment: panel,
        judgingAdjustment: judgeAdj,
        subTech: sub.tech,
        subChoreo: sub.choreo,
        isSolo: true,
        ddActualAvg: dd.actualAvg,
        ddNPast: dd.nPast,
        stdPast: stdPast,
      },
    );

    debugLog(entry, "[SoloAnalyticsModel] computeExpectedSolo", {
      base: base,
      panel: panel,
      sliceMeanAnch: sliceMeanAnch,
      agePeerAdj: agePeerAdj,
      styleAdj: styleAdj,
      judgeAdj: judgeAdj,
      subTech: sub.tech,
      subChoreo: sub.choreo,
      histWeighted: histWeighted,
      breakout: breakout,
      vol: vol,
      pre: pre,
      preAdj: preAdj,
      globalBias: globalBias,
      expected: expected,
    });

    var actual = parseGrandTotal(entry);
    var predictionStd = Math.max(
      2.8,
      CONFIDENCE_K_SOLO * stdPast + 4 / Math.sqrt(Math.max(1, dd.nEff || 1)),
    );
    var confN =
      ctx.nEffective != null && !isNaN(ctx.nEffective) && ctx.nEffective > 0
        ? ctx.nEffective
        : ctx.n;
    var confidence = getConfidenceLevelFromStats(stdPast, confN, dd.nPast, true);
    var confidenceNumeric = predictionConfidenceNumeric(stdPast, confN, dd.nPast);

    return {
      preBiasExpected: preAdj,
      expected: expected,
      actual: actual,
      contextBaseline: base,
      contextSampleSize: ctx.n,
      contextEffectiveSampleSize: confN,
      contextTier: ctx.tier,
      panelAdjustment: panel,
      styleAdjustment: styleAdj,
      judgingAdjustment: judgeAdj,
      subscoreTech: sub.tech,
      subscoreChoreo: sub.choreo,
      breakoutBoost: breakout,
      volatilityBoost: vol,
      agePeerAdjustment: agePeerAdj,
      dancerDelta: dd.delta,
      dancerWeight: getDancerWeight(entry, dataset),
      weightedDancerDelta: histWeighted,
      danceDelta: 0,
      danceWeight: 0,
      weightedDanceDelta: 0,
      nPriorSolos: dd.nPast,
      nPriorDancePerformances: 0,
      predictionStd: predictionStd,
      lowerBound: expected - predictionStd,
      upperBound: expected + predictionStd,
      confidence: confidence,
      confidenceNumeric: confidenceNumeric,
      globalBiasApplied: globalBias,
    };
  }

  function computeExpectedGroup(entry, dataset, opts) {
    opts = opts || {};
    var slice = datasetAsOf(entry, dataset);
    var compStats = opts.compStats || buildCompEventStats(slice);
    var globalBias = opts.globalBias != null ? opts.globalBias : 0;

    var ctx = getContextBaseline(entry, dataset, compStats, true);
    var base = ctx.baseline;
    if (isNaN(base)) {
      return {
        preBiasExpected: NaN,
        expected: NaN,
        actual: parseGrandTotal(entry),
        parts: {},
      };
    }

    var panel = getPanelAdjustment(entry, dataset, compStats);
    var styleAdj = eventStyleDeltaGT(entry, slice);
    var judgeAdj = eventJudgePanelAdjustment(entry, slice);
    var sub = subscoreMarginalGT(entry, slice, 0.72, 0.78);
    var dd = getDanceDeltaWeighted(entry, dataset);
    var pastGts = [];
    var i;
    for (i = 0; i < slice.length; i++) {
      var r = slice[i];
      if (r === entry) continue;
      if (!routineMatchesEntry(entry, r)) continue;
      var g = parseGrandTotal(r);
      if (!isNaN(g)) pastGts.push(g);
    }
    var dampDelta = groupHistoryStabilityDampen(pastGts, dd.delta);
    var histShrinkG = Math.min(1, Math.max(0, dd.nPast) / HISTORY_SHRINK_TARGET_N);
    var histWeighted =
      dampDelta * getDanceWeight(entry, dataset) * GROUP_W.hist * histShrinkG;
    var struct = groupStructuralCalibration(entry);

    var sliceMeanAnchG = sliceGrandMeanGT(slice, entry);
    var calMeanG = calibrationMeanOrDefault(slice, entry);
    var agePeerAdjG = agePeerRelativeAdjustment(entry, slice);

    var pre =
      base +
      GROUP_W.panel * panel +
      GROUP_W.tech * sub.tech +
      GROUP_W.choreo * sub.choreo +
      GROUP_W.judge * judgeAdj +
      GROUP_W.style * styleAdj +
      histWeighted +
      struct +
      agePeerAdjG;

    var preAdj = pre;
    if (
      !isNaN(base) &&
      base < IMPLAUSIBLE_BASELINE_MAX &&
      !isNaN(sliceMeanAnchG) &&
      sliceMeanAnchG >= MIN_RESCALE_SLICE_MEAN
    ) {
      preAdj = sliceMeanAnchG + (pre - base);
    }

    var preBias = preAdj + globalBias;
    var stretchProbeG = applyTopEndStretch(preBias);
    var expected = finalizeCalibratedExpected(preBias, calMeanG);
    if (
      !isNaN(stretchProbeG) &&
      stretchProbeG < CATASTROPHIC_EXPECTED_MAX &&
      !isNaN(sliceMeanAnchG) &&
      sliceMeanAnchG >= MIN_RESCALE_SLICE_MEAN
    ) {
      preAdj = sliceMeanAnchG + GROUP_W.panel * panel + agePeerAdjG;
      preBias = preAdj + globalBias;
      expected = finalizeCalibratedExpected(preBias, calMeanG);
    }

    var stdPastG = groupPriorGtStd(entry, dataset);
    expected = applyRealisticPostProcess(
      expected,
      entry,
      slice,
      dataset,
      calMeanG,
      opts.datasetGrandMean,
      {
        contextBaseline: base,
        panelAdjustment: panel,
        judgingAdjustment: judgeAdj,
        subTech: sub.tech,
        subChoreo: sub.choreo,
        isSolo: false,
        ddActualAvg: dd.actualAvg,
        ddNPast: dd.nPast,
        stdPast: stdPastG,
      },
    );

    debugLog(entry, "[SoloAnalyticsModel] computeExpectedGroup", {
      base: base,
      panel: panel,
      sliceMeanAnch: sliceMeanAnchG,
      pre: pre,
      preAdj: preAdj,
      expected: expected,
    });

    var actual = parseGrandTotal(entry);
    var predictionStd = Math.max(
      2.2,
      CONFIDENCE_K_GROUP * stdPastG + 3.2 / Math.sqrt(Math.max(1, dd.nEff || 1)),
    );
    var confN =
      ctx.nEffective != null && !isNaN(ctx.nEffective) && ctx.nEffective > 0
        ? ctx.nEffective
        : ctx.n;
    var confidence = getConfidenceLevelFromStats(stdPastG, confN, dd.nPast, false);
    var confidenceNumericG = predictionConfidenceNumeric(stdPastG, confN, dd.nPast);

    return {
      preBiasExpected: preAdj,
      expected: expected,
      actual: actual,
      contextBaseline: base,
      contextSampleSize: ctx.n,
      contextEffectiveSampleSize: confN,
      contextTier: ctx.tier,
      panelAdjustment: panel,
      styleAdjustment: styleAdj,
      judgingAdjustment: judgeAdj,
      subscoreTech: sub.tech,
      subscoreChoreo: sub.choreo,
      structuralGroupBoost: struct,
      agePeerAdjustment: agePeerAdjG,
      dancerDelta: 0,
      dancerWeight: 0,
      weightedDancerDelta: 0,
      danceDelta: dd.delta,
      danceWeight: getDanceWeight(entry, dataset),
      weightedDanceDelta: histWeighted,
      nPriorSolos: 0,
      nPriorDancePerformances: dd.nPast,
      predictionStd: predictionStd,
      lowerBound: expected - predictionStd,
      upperBound: expected + predictionStd,
      confidence: confidence,
      confidenceNumeric: confidenceNumericG,
      globalBiasApplied: globalBias,
    };
  }

  function assembleMetrics(m, entry) {
    var actual = m.actual;
    var expected = m.expected;
    var difference = isNaN(expected) || isNaN(actual) ? NaN : actual - expected;
    var solo = isSoloRow(entry);
    return {
      expected: expected,
      actual: actual,
      difference: difference,
      contextBaseline: m.contextBaseline,
      contextSampleSize: m.contextSampleSize,
      contextEffectiveSampleSize: m.contextEffectiveSampleSize,
      contextTier: m.contextTier,
      confidence: m.confidence,
      confidenceNumeric:
        m.confidenceNumeric != null && !isNaN(m.confidenceNumeric) ? m.confidenceNumeric : NaN,
      panelAdjustment: m.panelAdjustment,
      adjustmentIsSolo: solo,
      dancerDelta: solo ? m.dancerDelta : 0,
      dancerWeight: solo ? m.dancerWeight : 0,
      weightedDancerDelta: solo ? m.weightedDancerDelta : 0,
      dancerActualAvg: NaN,
      dancerExpectedAvg: NaN,
      nPriorSolos: solo ? m.nPriorSolos : 0,
      danceDelta: solo ? 0 : m.danceDelta,
      danceWeight: solo ? 0 : m.danceWeight,
      weightedDanceDelta: solo ? 0 : m.weightedDanceDelta,
      danceActualAvg: NaN,
      danceExpectedAvg: NaN,
      nPriorDancePerformances: solo ? 0 : m.nPriorDancePerformances,
      judgingAdjustment: m.judgingAdjustment,
      styleAdjustment: m.styleAdjustment,
      subscoreTech: m.subscoreTech,
      subscoreChoreo: m.subscoreChoreo,
      agePeerAdjustment: m.agePeerAdjustment != null ? m.agePeerAdjustment : 0,
      preBiasExpected: m.preBiasExpected,
      globalBiasApplied: m.globalBiasApplied,
      predictionStd: m.predictionStd,
      lowerBound: m.lowerBound,
      upperBound: m.upperBound,
    };
  }

  /** Fix dancer Avg fields from weighted delta path. */
  function metricsWithDanceAvgs(entry, baseM, dataset) {
    var solo = isSoloRow(entry);
    var out = assembleMetrics(baseM, entry);
    if (solo) {
      var dd = getDancerDeltaWeighted(entry, dataset, false);
      out.dancerActualAvg = dd.actualAvg;
      out.dancerExpectedAvg = dd.expectedAvg;
    } else {
      var dg = getDanceDeltaWeighted(entry, dataset);
      out.danceActualAvg = dg.actualAvg;
      out.danceExpectedAvg = dg.expectedAvg;
    }
    return out;
  }

  function computePredictionBiasCorrections(dataset) {
    var soloItems = [];
    var groupItems = [];
    var datasetGrandMean = computeDatasetGrandMeanGT(dataset);
    var i;
    for (i = 0; i < dataset.length; i++) {
      var r = dataset[i];
      if (isNaN(parseGrandTotal(r))) continue;
      var slice = datasetAsOf(r, dataset);
      var compStats = buildCompEventStats(slice);
      var rowOpts = {
        compStats: compStats,
        globalBias: 0,
        datasetGrandMean: datasetGrandMean,
      };
      if (isSoloRow(r)) {
        var ms = computeExpectedSolo(r, dataset, rowOpts);
        if (!isNaN(ms.preBiasExpected)) {
          soloItems.push({
            key: rowChronoKey(r),
            res: parseGrandTotal(r) - ms.preBiasExpected,
          });
        }
      } else {
        var mg = computeExpectedGroup(r, dataset, rowOpts);
        if (!isNaN(mg.preBiasExpected)) {
          groupItems.push({
            key: rowChronoKey(r),
            res: parseGrandTotal(r) - mg.preBiasExpected,
          });
        }
      }
    }

    function segmentBias(items) {
      if (!items.length) {
        return { early: 0, late: 0, lo: null, hi: null, mean: 0 };
      }
      var withKey = [];
      var j;
      for (j = 0; j < items.length; j++) {
        if (items[j].key != null) withKey.push(items[j]);
      }
      var mn = meanArr(
        items.map(function (x) {
          return x.res;
        }),
      );
      var fallback = capBias(mn);
      if (withKey.length < 6) {
        return { early: fallback, late: fallback, lo: null, hi: null, mean: fallback };
      }
      withKey.sort(function (a, b) {
        return a.key - b.key;
      });
      var mid = Math.floor(withKey.length / 2);
      var earlyP = withKey.slice(0, mid);
      var lateP = withKey.slice(mid);
      var bE = meanArr(
        earlyP.map(function (x) {
          return x.res;
        }),
      );
      var bL = meanArr(
        lateP.map(function (x) {
          return x.res;
        }),
      );
      return {
        early: capBias(bE),
        late: capBias(bL),
        lo: withKey[0].key,
        hi: withKey[withKey.length - 1].key,
        mean: fallback,
      };
    }

    var sb = segmentBias(soloItems);
    var gb = segmentBias(groupItems);

    return {
      soloBiasEarly: sb.early,
      soloBiasLate: sb.late,
      soloChronoLo: sb.lo,
      soloChronoHi: sb.hi,
      soloBias: sb.mean,
      groupBiasEarly: gb.early,
      groupBiasLate: gb.late,
      groupChronoLo: gb.lo,
      groupChronoHi: gb.hi,
      groupBias: gb.mean,
    };
  }

  function getExpectedScore(entry, dataset, biasBundle, datasetGrandMean) {
    biasBundle = biasBundle || {};
    var soloBias = effectiveSoloBias(biasBundle, entry);
    var groupBias = effectiveGroupBias(biasBundle, entry);
    var slice = datasetAsOf(entry, dataset);
    var compStats = buildCompEventStats(slice);
    var dgm =
      datasetGrandMean != null && !isNaN(datasetGrandMean)
        ? datasetGrandMean
        : computeDatasetGrandMeanGT(dataset);
    var m;
    if (isSoloRow(entry)) {
      m = computeExpectedSolo(entry, dataset, {
        compStats: compStats,
        globalBias: soloBias,
        datasetGrandMean: dgm,
      });
    } else {
      m = computeExpectedGroup(entry, dataset, {
        compStats: compStats,
        globalBias: groupBias,
        datasetGrandMean: dgm,
      });
    }
    return metricsWithDanceAvgs(entry, m, dataset);
  }

  function computeSoloDatasetAnalytics(dataset) {
    var bc = computePredictionBiasCorrections(dataset);
    var datasetGrandMean = computeDatasetGrandMeanGT(dataset);
    var rows = [];
    var i;
    for (i = 0; i < dataset.length; i++) {
      var r = dataset[i];
      if (!isSoloRow(r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      rows.push({
        row: r,
        index: i,
        metrics: getExpectedScore(r, dataset, bc, datasetGrandMean),
      });
    }
    return rows;
  }

  function computeNonSoloDatasetAnalytics(dataset) {
    var bc = computePredictionBiasCorrections(dataset);
    var datasetGrandMean = computeDatasetGrandMeanGT(dataset);
    var rows = [];
    var i;
    for (i = 0; i < dataset.length; i++) {
      var r = dataset[i];
      if (isSoloRow(r)) continue;
      if (isNaN(parseGrandTotal(r))) continue;
      rows.push({
        row: r,
        index: i,
        metrics: getExpectedScore(r, dataset, bc, datasetGrandMean),
      });
    }
    return rows;
  }

  /**
   * One bias calibration + one pass over scored rows — avoids running computePredictionBiasCorrections twice
   * when both solo and non-solo tables are needed (saves ~N full predictions on N-row sets).
   */
  function computeSoloAndNonSoloDatasetAnalytics(dataset) {
    var bc = computePredictionBiasCorrections(dataset);
    var datasetGrandMean = computeDatasetGrandMeanGT(dataset);
    var soloRows = [];
    var nonSoloRows = [];
    var i;
    for (i = 0; i < dataset.length; i++) {
      var r = dataset[i];
      if (isNaN(parseGrandTotal(r))) continue;
      var item = {
        row: r,
        index: i,
        metrics: getExpectedScore(r, dataset, bc, datasetGrandMean),
      };
      if (isSoloRow(r)) soloRows.push(item);
      else nonSoloRows.push(item);
    }
    return { solo: soloRows, nonSolo: nonSoloRows };
  }

  /**
   * Same as computeSoloAndNonSoloDatasetAnalytics but yields to the event loop between batches so the UI
   * can paint (loading text, modal scrolling). Uses a single bias pass + chunked row scoring.
   *
   * @param {object[]} dataset
   * @param {{ batchSize?: number, onProgress?: function(info: object): void }} [opts]
   * @returns {Promise<{ solo: object[], nonSolo: object[] }>}
   */
  function computeSoloAndNonSoloDatasetAnalyticsBatched(dataset, opts) {
    opts = opts || {};
    var batchSize = Math.max(1, opts.batchSize | 0 || 40);
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    return new Promise(function (resolve, reject) {
      function fail(e) {
        reject(e);
      }

      function runBiasPhase() {
        try {
          if (onProgress) onProgress({ phase: "bias", fraction: 0 });
          setTimeout(function () {
            try {
              var bc = computePredictionBiasCorrections(dataset);
              var datasetGrandMean = computeDatasetGrandMeanGT(dataset);
              var work = [];
              var i;
              for (i = 0; i < dataset.length; i++) {
                var r = dataset[i];
                if (isNaN(parseGrandTotal(r))) continue;
                work.push({ r: r, idx: i, solo: isSoloRow(r) });
              }
              var soloRows = [];
              var nonSoloRows = [];
              var k = 0;
              var total = work.length;

              function rowStep() {
                try {
                  var end = Math.min(k + batchSize, total);
                  for (; k < end; k++) {
                    var w = work[k];
                    var item = {
                      row: w.r,
                      index: w.idx,
                      metrics: getExpectedScore(w.r, dataset, bc, datasetGrandMean),
                    };
                    if (w.solo) soloRows.push(item);
                    else nonSoloRows.push(item);
                  }
                  if (onProgress) {
                    onProgress({
                      phase: "rows",
                      fraction: total ? k / total : 1,
                      done: k,
                      total: total,
                    });
                  }
                  if (k < total) {
                    setTimeout(rowStep, 0);
                  } else {
                    resolve({ solo: soloRows, nonSolo: nonSoloRows });
                  }
                } catch (eRow) {
                  fail(eRow);
                }
              }

              if (total === 0) {
                resolve({ solo: [], nonSolo: [] });
              } else {
                setTimeout(rowStep, 0);
              }
            } catch (eBias) {
              fail(eBias);
            }
          }, 0);
        } catch (eWrap) {
          fail(eWrap);
        }
      }

      setTimeout(runBiasPhase, 0);
    });
  }

  /** @deprecated Use getConfidenceLevelFromStats via metrics; kept for callers. */
  function getConfidenceLevel(contextN) {
    if (contextN >= 15) return "high";
    if (contextN >= 6) return "medium";
    return "low";
  }

  /** Back-compat wrappers */
  function getDancerDelta(entry, dataset) {
    var d = getDancerDeltaWeighted(entry, dataset, false);
    return {
      delta: d.delta,
      actualAvg: d.actualAvg,
      expectedAvg: d.expectedAvg,
      nPast: d.nPast,
    };
  }

  function getDanceDelta(entry, dataset) {
    var d = getDanceDeltaWeighted(entry, dataset);
    return {
      delta: d.delta,
      actualAvg: d.actualAvg,
      expectedAvg: d.expectedAvg,
      nPast: d.nPast,
    };
  }

  global.SoloAnalyticsModel = {
    SOLO_EXPECTED_GT_MAX: SOLO_EXPECTED_GT_MAX,
    NOMINAL_SCORE_CAP: NOMINAL_SCORE_CAP,
    CALIBRATE_MEAN: CALIBRATE_MEAN,
    CALIBRATE_SCALE: CALIBRATE_SCALE,
    BIAS_ABS_CAP: BIAS_ABS_CAP,
    AGE_Z_K: AGE_Z_K,
    AGE_ADJ_MAX: AGE_ADJ_MAX,
    HIGH_TAIL_START: HIGH_TAIL_START,
    HIGH_TAIL_PULL: HIGH_TAIL_PULL,
    MIN_SCORE_REALISTIC: MIN_SCORE_REALISTIC,
    TOP_END_STRETCH: TOP_END_STRETCH,
    TOP_END_EXP: TOP_END_EXP,
    TOP_END_THRESHOLD: TOP_END_THRESHOLD,
    finalizeCalibratedExpected: finalizeCalibratedExpected,
    calibrateScore: calibrateScore,
    calibrationMeanOrDefault: calibrationMeanOrDefault,
    capBias: capBias,
    softFloorScore: softFloorScore,
    softCapScore: softCapScore,
    highTailCompress: highTailCompress,
    compressScore: compressScore,
    REALISTIC_POST_V2: REALISTIC_POST_V2,
    computeDatasetGrandMeanGT: computeDatasetGrandMeanGT,
    AGE_KEYS: AGE_KEYS,
    TECH_KEYS: TECH_KEYS,
    CHOREO_KEYS: CHOREO_KEYS,
    setPredictionDeps: setPredictionDeps,
    getPredictionDeps: getPredictionDeps,
    buildCompEventStats: buildCompEventStats,
    compMeanExcluding: compMeanExcluding,
    sliceGrandMeanGT: sliceGrandMeanGT,
    setDebugDanceNames: setDebugDanceNames,
    getContextBaseline: getContextBaseline,
    getPanelAdjustment: getPanelAdjustment,
    getDancerDelta: getDancerDelta,
    getDancerWeight: getDancerWeight,
    getDanceDelta: getDanceDelta,
    getDanceWeight: getDanceWeight,
    rowRoutineKey: rowRoutineKey,
    computeExpectedSolo: computeExpectedSolo,
    computeExpectedGroup: computeExpectedGroup,
    computePredictionBiasCorrections: computePredictionBiasCorrections,
    getExpectedScore: getExpectedScore,
    getConfidenceLevel: getConfidenceLevel,
    computeSoloDatasetAnalytics: computeSoloDatasetAnalytics,
    computeNonSoloDatasetAnalytics: computeNonSoloDatasetAnalytics,
    computeSoloAndNonSoloDatasetAnalytics: computeSoloAndNonSoloDatasetAnalytics,
    computeSoloAndNonSoloDatasetAnalyticsBatched: computeSoloAndNonSoloDatasetAnalyticsBatched,
    isSoloRow: isSoloRow,
    parseGrandTotal: parseGrandTotal,
    primaryDancerName: primaryDancerName,
    rowCompEventKey: rowCompEventKey,
    rowChronoKey: rowChronoKey,
    datasetAsOf: datasetAsOf,
  };
})(typeof window !== "undefined" ? window : this);
