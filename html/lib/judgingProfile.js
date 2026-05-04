/**
 * Judging Profile — derived metrics & presentation helpers.
 * Maps sheet rows → normalized entries → aggregates. Replace/refine TODOs for production.
 * @see types/judging.js (JSDoc typedefs)
 */
(function (global) {
  "use strict";

  var TECH_KEYS = ["Avg. Technique", "AVG. Technique", "Avg Technique"];
  var CHOREO_KEYS = [
    "AVG. Choreo & performance",
    "Avg. Choreo & performance",
    "AVG. Choreo and performance",
    "Avg. Choreo and performance",
  ];
  var LOW_SAMPLE_MAX = 2;
  /** Category labels excluded from judging snapshot (mixed-genre / non-style-pure groups). */
  var EXCLUDED_JUDGING_PROFILE_CATEGORIES = {
    "grand line": true,
    production: true,
  };

  function isRowExcludedFromJudgingProfile(row) {
    var cat = String(row.Category || "")
      .trim()
      .toLowerCase();
    return !!EXCLUDED_JUDGING_PROFILE_CATEGORIES[cat];
  }

  function mean(arr) {
    if (!arr || !arr.length) return NaN;
    var s = 0;
    var i;
    for (i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function safeFixed(n, d) {
    if (n == null || typeof n !== "number" || isNaN(n)) return "—";
    return n.toFixed(d != null ? d : 1);
  }

  /**
   * @param {object} row
   * @param {{ parseGrandTotal: function, rowFirstNumeric: function, extractEliteFeetJudgeBreakdown: function }} deps
   */
  function sheetRowToEntry(row, deps) {
    if (isRowExcludedFromJudgingProfile(row)) return null;
    var gt = deps.parseGrandTotal(row);
    if (isNaN(gt)) return null;
    var tech = deps.rowFirstNumeric(row, TECH_KEYS);
    var choreo = deps.rowFirstNumeric(row, CHOREO_KEYS);
    var elite = deps.extractEliteFeetJudgeBreakdown(row);
    var judgePairs = [];
    var n = Math.min(elite.technique.length, elite.choreo.length);
    var i;
    for (i = 0; i < n; i++) {
      var t = elite.technique[i].value;
      var c = elite.choreo[i].value;
      if (isNaN(t) || isNaN(c)) continue;
      judgePairs.push({ tech: t, choreo: c });
    }
    return {
      style: String(row.Style || "").trim() || "Other",
      category: String(row.Category || "").trim() || "Other",
      level: String(row.Level || "").trim() || "",
      danceName: String(row["Dance Name"] || "").trim() || "",
      grandTotal: gt,
      avgTechnique: tech && !isNaN(tech.value) ? tech.value : NaN,
      avgChoreo: choreo && !isNaN(choreo.value) ? choreo.value : NaN,
      judgePairs: judgePairs,
    };
  }

  function getCompetitionEntries(rows, deps) {
    var out = [];
    var ri;
    for (ri = 0; ri < rows.length; ri++) {
      var e = sheetRowToEntry(rows[ri], deps);
      if (e) out.push(e);
    }
    return out;
  }

  function getCompetitionAverages(entries) {
    if (!entries.length) {
      return {
        totalEntries: 0,
        avgGrandTotal: NaN,
        avgTechnique: NaN,
        avgChoreo: NaN,
      };
    }
    var gt = entries.map(function (e) {
      return e.grandTotal;
    });
    var techs = entries
      .map(function (e) {
        return e.avgTechnique;
      })
      .filter(function (x) {
        return !isNaN(x);
      });
    var chos = entries
      .map(function (e) {
        return e.avgChoreo;
      })
      .filter(function (x) {
        return !isNaN(x);
      });
    return {
      totalEntries: entries.length,
      avgGrandTotal: mean(gt),
      avgTechnique: techs.length ? mean(techs) : NaN,
      avgChoreo: chos.length ? mean(chos) : NaN,
    };
  }

  function buildAxisProfiles(entries, axisKeyFn, compAvgGrand) {
    var map = {};
    entries.forEach(function (e) {
      var k = axisKeyFn(e);
      if (!map[k]) map[k] = { totals: [], techs: [], chos: [] };
      map[k].totals.push(e.grandTotal);
      if (!isNaN(e.avgTechnique)) map[k].techs.push(e.avgTechnique);
      if (!isNaN(e.avgChoreo)) map[k].chos.push(e.avgChoreo);
    });
    return Object.keys(map).map(function (k) {
      var g = map[k];
      var avgTotal = mean(g.totals);
      var avgTechnique = g.techs.length ? mean(g.techs) : NaN;
      var avgChoreo = g.chos.length ? mean(g.chos) : NaN;
      return {
        label: k,
        entryCount: g.totals.length,
        avgTotal: avgTotal,
        avgTechnique: avgTechnique,
        avgChoreo: avgChoreo,
        deltaFromCompAvg: !isNaN(avgTotal) && !isNaN(compAvgGrand) ? avgTotal - compAvgGrand : undefined,
      };
    });
  }

  function getGenreProfiles(entries, compAvgGrand) {
    return buildAxisProfiles(
      entries,
      function (e) {
        return e.style;
      },
      compAvgGrand,
    );
  }

  function getCategoryProfiles(entries, compAvgGrand) {
    return buildAxisProfiles(
      entries,
      function (e) {
        return e.category;
      },
      compAvgGrand,
    );
  }

  function sortProfilesByMetric(profiles, metric) {
    var copy = profiles.slice();
    copy.sort(function (a, b) {
      var va = metric === "total" ? a.avgTotal : metric === "technique" ? a.avgTechnique : a.avgChoreo;
      var vb = metric === "total" ? b.avgTotal : metric === "technique" ? b.avgTechnique : b.avgChoreo;
      if (isNaN(va) && isNaN(vb)) return 0;
      if (isNaN(va)) return 1;
      if (isNaN(vb)) return -1;
      return vb - va;
    });
    return copy;
  }

  /** Genres/categories with enough routines to compare (same threshold as “small sample” chips). */
  function profilesWithAdequateSample(profiles) {
    return profiles.filter(function (p) {
      return p.entryCount > LOW_SAMPLE_MAX;
    });
  }

  /** Highest / lowest profile by metric among adequate-sample genres only. */
  function genreMetricHighLow(genreProfiles, metric) {
    var ok = profilesWithAdequateSample(genreProfiles).filter(function (p) {
      var v = metric === "technique" ? p.avgTechnique : p.avgChoreo;
      return !isNaN(v);
    });
    if (!ok.length) return { hi: null, lo: null };
    var s = sortProfilesByMetric(ok, metric);
    var hi = s[0];
    var lo = s[s.length - 1];
    if (hi === lo) return { hi: hi, lo: null };
    return { hi: hi, lo: lo };
  }

  /** @type {function(entries: object[]): import('../types/judging').PanelConsistencySummary} */
  function getPanelConsistency(entries, judgeProfiles) {
    /* TODO: refine with ICC / std of normalized scores when production stats land */
    if (!judgeProfiles || judgeProfiles.length < 2) {
      return {
        label: "Single judge",
        shortDescription: "Need 2+ judge columns on these rows to measure spread.",
        value: undefined,
      };
    }
    var techs = judgeProfiles
      .map(function (j) {
        return j.avgTechnique;
      })
      .filter(function (x) {
        return !isNaN(x);
      });
    if (techs.length < 2) {
      return {
        label: "Limited data",
        shortDescription: "Not enough per-judge technique scores to compare.",
        value: undefined,
      };
    }
    var spread = Math.max.apply(null, techs) - Math.min.apply(null, techs);
    /* Bands are max−min of each judge’s mean technique across routines. Averaging many
       scores pulls judge means together, so “tight” must be stricter than ~2 pts or
       almost every event reads as tight agreement. */
    var tightMax = 1;
    var wideMin = 4;
    var label = "Balanced";
    var shortDescription =
      "Judge technique averages span about " + spread.toFixed(1) + " pts (max − min).";
    if (spread <= tightMax) {
      label = "Tight agreement";
      shortDescription =
        "Technique means within about " +
        tightMax +
        " pt — panel landed in a narrow band on averages.";
    } else if (spread >= wideMin) {
      label = "Wide spread";
      shortDescription = "Technique means diverge — compare judge cards below.";
    }
    return { label: label, shortDescription: shortDescription, value: spread };
  }

  function scoringStyleTag(avgTech, avgChoreo) {
    if (!isNaN(avgTech) && !isNaN(avgChoreo)) {
      if (avgTech - avgChoreo > 2.5) return "Technique-Leaning";
      if (avgChoreo - avgTech > 2.5) return "Performance-Leaning";
    }
    return "Balanced";
  }

  function getJudgeProfiles(entries) {
    var maxJ = 0;
    entries.forEach(function (e) {
      if (e.judgePairs.length > maxJ) maxJ = e.judgePairs.length;
    });
    if (!maxJ) return [];

    var judges = [];
    var j;
    for (j = 0; j < maxJ; j++) {
      var styleByTech = {};
      var tVals = [];
      var cVals = [];
      entries.forEach(function (e) {
        var p = e.judgePairs[j];
        if (!p) return;
        tVals.push(p.tech);
        cVals.push(p.choreo);
        if (!styleByTech[e.style]) styleByTech[e.style] = [];
        styleByTech[e.style].push(p.tech);
      });
      if (!tVals.length) continue;

      var styleMeansTech = Object.keys(styleByTech).map(function (sk) {
        return { genre: sk, avgTechnique: mean(styleByTech[sk]) };
      });
      styleMeansTech.sort(function (a, b) {
        return b.avgTechnique - a.avgTechnique;
      });
      var topGenresByTechnique = styleMeansTech.slice(0, 3);

      var avgTechnique = mean(tVals);
      var avgChoreo = mean(cVals);

      judges.push({
        judgeId: String(j + 1),
        avgTechnique: avgTechnique,
        avgChoreo: avgChoreo,
        topGenresByTechnique: topGenresByTechnique,
        scoringStyle: scoringStyleTag(avgTechnique, avgChoreo),
      });
    }
    return judges;
  }

  /**
   * @returns {object} model for renderPaneHTML
   */
  function buildModel(rows, ctx, deps) {
    var entries = getCompetitionEntries(rows, deps);
    var averages = getCompetitionAverages(entries);
    var compAvgGrand = averages.avgGrandTotal;
    var genreProfiles = getGenreProfiles(entries, compAvgGrand);
    var categoryProfiles = getCategoryProfiles(entries, compAvgGrand);
    var judgeProfiles = getJudgeProfiles(entries);
    var consistency = getPanelConsistency(entries, judgeProfiles);
    return {
      context: ctx,
      entries,
      averages,
      genreProfiles,
      categoryProfiles,
      judgeProfiles,
      consistency,
      hasJudgeBreakdown: judgeProfiles.length > 0,
    };
  }

  function profileMetricValue(p, metric) {
    if (metric === "total") return p.avgTotal;
    if (metric === "technique") return p.avgTechnique;
    return p.avgChoreo;
  }

  /** Genre / category modules with metric toggles (Total · Technique · Choreo). */
  function renderBarSectionFixed(panelId, title, profiles, esc) {
    var sorted = sortProfilesByMetric(profiles, "total");
    var html = renderInnerBars(sorted, "total", esc);
    return (
      '<div class="jp-analytic" data-jp-panel="' +
      panelId +
      '"><h3 class="jp-analytic__title">' +
      esc(title) +
      '</h3><div class="jp-toggle" role="tablist"><button type="button" class="jp-toggle__btn is-active" data-jp-panel="' +
      panelId +
      '" data-jp-metric="total">Total</button><button type="button" class="jp-toggle__btn" data-jp-panel="' +
      panelId +
      '" data-jp-metric="technique">Technique</button><button type="button" class="jp-toggle__btn" data-jp-panel="' +
      panelId +
      '" data-jp-metric="choreo">Choreo</button></div><div class="jp-bars" data-jp-bars-for="' +
      panelId +
      '">' +
      html +
      "</div></div>"
    );
  }

  function renderInnerBars(sorted, metric, esc) {
    var vals = sorted
      .map(function (p) {
        return profileMetricValue(p, metric);
      })
      .filter(function (x) {
        return !isNaN(x);
      });
    var maxVal = vals.length ? Math.max.apply(null, vals) : 1;
    if (maxVal <= 0) maxVal = 1;
    return sorted
      .map(function (p) {
        var v = profileMetricValue(p, metric);
        var weak = p.entryCount <= LOW_SAMPLE_MAX;
        var pct = !isNaN(v) ? Math.min(100, Math.round((v / maxVal) * 100)) : 0;
        var deltaChip = "";
        if (weak)
          deltaChip = '<span class="jp-chip jp-chip--weak">Small sample</span>';
        var valStr = !isNaN(v) ? v.toFixed(1) : "—";
        return (
          '<div class="jp-bar-row' +
          (weak ? " jp-bar-row--muted" : "") +
          '"><div class="jp-bar-row__meta"><span class="jp-bar-row__label">' +
          esc(p.label) +
          '</span><span class="jp-bar-row__n">' +
          p.entryCount +
          " routine(s)" +
          '</span></div><div class="jp-bar-row__track"><div class="jp-bar-row__fill" style="width:' +
          pct +
          '%"></div></div><div class="jp-bar-row__val">' +
          valStr +
          "</div>" +
          (deltaChip ? '<div class="jp-bar-row__chips">' + deltaChip + "</div>" : "") +
          "</div>"
        );
      })
      .join("");
  }

  function renderSummaryCards(model, esc) {
    var a = model.averages;
    var genres = sortProfilesByMetric(model.genreProfiles, "total");
    var hiG = genres.length && !isNaN(genres[0].avgTotal) ? genres[0] : null;
    var adequateForStrictest = profilesWithAdequateSample(model.genreProfiles).filter(function (p) {
      return !isNaN(p.avgTotal);
    });
    var loG = null;
    if (adequateForStrictest.length > 1) {
      var sortedByTotal = sortProfilesByMetric(adequateForStrictest, "total");
      loG = sortedByTotal[sortedByTotal.length - 1];
    }
    if (loG && hiG && loG.label === hiG.label) loG = null;
    var techHL = genreMetricHighLow(model.genreProfiles, "technique");
    var choreoHL = genreMetricHighLow(model.genreProfiles, "choreo");
    var minN = LOW_SAMPLE_MAX + 1;
    var techSub = techHL.hi
      ? "Highest: " +
        safeFixed(techHL.hi.avgTechnique, 1) +
        " (" +
        esc(techHL.hi.label) +
        ")" +
        (techHL.lo
          ? "<br>Lowest: " +
            safeFixed(techHL.lo.avgTechnique, 1) +
            " (" +
            esc(techHL.lo.label) +
            ")"
          : "") +
        '<br><br><span class="jp-summary-card__hint">Genre highs/lows: genres with n≥' +
        minN +
        " only.</span>"
      : '<span class="jp-summary-card__hint">No genre highs/lows yet (need n≥' +
        minN +
        " per style).</span>";
    var choreoSub = choreoHL.hi
      ? "Highest: " +
        safeFixed(choreoHL.hi.avgChoreo, 1) +
        " (" +
        esc(choreoHL.hi.label) +
        ")" +
        (choreoHL.lo
          ? "<br>Lowest: " +
            safeFixed(choreoHL.lo.avgChoreo, 1) +
            " (" +
            esc(choreoHL.lo.label) +
            ")"
          : "") +
        '<br><br><span class="jp-summary-card__hint">Genre highs/lows: genres with n≥' +
        minN +
        " only.</span>"
      : '<span class="jp-summary-card__hint">No genre highs/lows yet (need n≥' +
        minN +
        " per style).</span>";
    var cons = model.consistency;
    var cards = [
      {
        k: "Overall",
        v: safeFixed(a.avgGrandTotal, 1),
        sub: "Mean Grand Total",
        accent: "blue",
      },
      {
        k: "Technique",
        v: safeFixed(a.avgTechnique, 1),
        sub: techSub,
        accent: "red",
      },
      {
        k: "Choreo",
        v: safeFixed(a.avgChoreo, 1),
        sub: choreoSub,
        accent: "orange",
      },
      {
        k: "Top genre",
        v: hiG ? esc(hiG.label) : "—",
        sub: hiG ? safeFixed(hiG.avgTotal, 1) + " avg · n=" + hiG.entryCount : "—",
        accent: "green",
      },
      {
        k: "Strictest genre",
        v:
          loG && hiG && loG.label !== hiG.label
            ? esc(loG.label)
            : "—",
        sub: loG
          ? safeFixed(loG.avgTotal, 1) + " mean · n=" + loG.entryCount
          : adequateForStrictest.length <= 1
            ? "Need 2+ genres with n≥" + minN + " to identify strictest."
            : "—",
        accent: "green",
      },
      {
        k: "Panel fit",
        v: esc(cons.label),
        sub: esc(cons.shortDescription),
        accent: "blue",
        tip: true,
      },
    ];
    return cards
      .map(function (c, idx) {
        return (
          '<article class="jp-summary-card jp-summary-card--' +
          c.accent +
          '" style="animation-delay:' +
          idx * 0.05 +
          's"><p class="jp-summary-card__k">' +
          (c.tip
            ? '<span class="jp-summary-card__k-inner">' +
              c.k +
              '<span class="jp-info" tabindex="0" title="Spread of judge technique averages on this date. Refine with full statistics later.">i</span></span>'
            : esc(c.k)) +
          '</p><p class="jp-summary-card__v">' +
          c.v +
          '</p><p class="jp-summary-card__s">' +
          c.sub +
          "</p></article>"
        );
      })
      .join("");
  }

  function renderJudgeCards(judgeProfiles, esc) {
    if (!judgeProfiles.length) {
      return (
        '<p class="jp-empty-note">Per-judge JDG Technique / Choreo columns were not found on these exports. Grand totals and sheet averages above still reflect this event.</p>'
      );
    }
    return (
      '<div class="jp-judge-grid">' +
      judgeProfiles
        .map(function (j) {
          var tagClass = "jp-tag--" + j.scoringStyle.replace(/\s+/g, "-").toLowerCase();
          var tagHtml =
            j.scoringStyle !== "Balanced"
              ? '<span class="jp-tag ' +
                tagClass +
                '">' +
                esc(j.scoringStyle) +
                "</span>"
              : "";
          var tops = j.topGenresByTechnique || [];
          var topRows =
            tops.length > 0
              ? tops
                  .map(function (g, i) {
                    return (
                      '<div class="jp-judge-top__row"><span class="jp-judge-top__i">' +
                      (i + 1) +
                      '</span><span class="jp-judge-top__name">' +
                      esc(g.genre) +
                      '</span><span class="jp-judge-top__val">' +
                      safeFixed(g.avgTechnique, 1) +
                      "</span></div>"
                    );
                  })
                  .join("")
              : '<div class="jp-judge-top__row jp-judge-top__row--empty">—</div>';
          return (
            '<article class="jp-judge-card"><div class="jp-judge-card__head"><h4 class="jp-judge-card__title">Judge ' +
            esc(j.judgeId) +
            "</h4>" +
            tagHtml +
            '</div><dl class="jp-judge-card__dl"><div><dt>Avg technique</dt><dd>' +
            safeFixed(j.avgTechnique, 1) +
            '</dd></div><div><dt>Avg choreo</dt><dd>' +
            safeFixed(j.avgChoreo, 1) +
            '</dd></div><div class="jp-judge-card__top-block"><dt>Top genres (avg technique)</dt><dd class="jp-judge-card__top-dd"><div class="jp-judge-top-list">' +
            topRows +
            "</div></dd></div></dl></article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderPaneHTML(model, esc) {
    if (!model.entries.length) {
      return (
        '<div class="jp-empty"><p class="jp-empty__p">No scored routines for this event date.</p></div>'
      );
    }
    var ctx = model.context;
    var genreHtml = renderBarSectionFixed("genre", "Genre / style profile", model.genreProfiles, esc);
    var catHtml = renderBarSectionFixed(
      "category",
      "Category profile",
      model.categoryProfiles,
      esc,
    );
    var overviewInner =
      '<header class="jp-hero"><div class="jp-hero__text"><p class="jp-eyebrow">Judging intelligence</p><h2 class="jp-h">Judging Profile</h2><p class="jp-sub">How this panel scored at this competition.</p><p class="jp-meta">' +
      esc(ctx.competitionName || "Event") +
      " · " +
      esc(ctx.competitionDate || "—") +
      " · " +
      model.averages.totalEntries +
      ' entries</p></div></header><p class="jp-disclaimer">Averages use only routines entered at this event date. <strong>Grand Line</strong> and <strong>Production</strong> categories are omitted (mixed-genre / show pieces). Small groups are muted — do not over-read them.</p><div class="jp-summary-grid">' +
      renderSummaryCards(model, esc) +
      "</div>";
    var judgesInner =
      '<section class="jp-judges"><h3 class="jp-judges__h">Individual judges</h3>' +
      renderJudgeCards(model.judgeProfiles, esc) +
      "</section>";
    var strip =
      '<div class="jp-strip" role="tablist" aria-label="Profile sections">' +
      '<button type="button" class="jp-strip__btn is-active" role="tab" aria-selected="true" data-jp-slide="0">Overview</button>' +
      '<button type="button" class="jp-strip__btn" role="tab" aria-selected="false" data-jp-slide="1">Genre</button>' +
      '<button type="button" class="jp-strip__btn" role="tab" aria-selected="false" data-jp-slide="2">Category</button>' +
      '<button type="button" class="jp-strip__btn" role="tab" aria-selected="false" data-jp-slide="3">Judges</button>' +
      '<button type="button" class="jp-strip__btn" role="tab" aria-selected="false" data-jp-slide="4">By event</button>' +
      "</div>" +
      '<p class="jp-swipe-hint" aria-hidden="true">Swipe sideways or tap a tab</p>';
    return (
      '<div class="jp-stage">' +
      strip +
      '<div class="jp-rail" id="jp-rail" tabindex="0" aria-label="Swipe between profile sections">' +
      '<section class="jp-slide jp-slide--overview" data-jp-slide-index="0" aria-label="Overview">' +
      overviewInner +
      "</section>" +
      '<section class="jp-slide" data-jp-slide-index="1" aria-label="Genre">' +
      genreHtml +
      "</section>" +
      '<section class="jp-slide" data-jp-slide-index="2" aria-label="Category">' +
      catHtml +
      "</section>" +
      '<section class="jp-slide jp-slide--judges" data-jp-slide-index="3" aria-label="Judges">' +
      judgesInner +
      "</section>" +
      "<!--JP-BOX-SLOT-->" +
      "</div></div>"
    );
  }

  function updatePanelBars(rootEl, panelId, profiles, metric, esc) {
    var host = rootEl.querySelector('[data-jp-bars-for="' + panelId + '"]');
    if (!host) return;
    var sorted = sortProfilesByMetric(profiles, metric);
    host.innerHTML = renderInnerBars(sorted, metric, esc);
    var panel = rootEl.querySelector('[data-jp-panel="' + panelId + '"]');
    if (!panel) return;
    var btns = panel.querySelectorAll("[data-jp-metric]");
    btns.forEach(function (b) {
      var on = b.getAttribute("data-jp-metric") === metric;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  global.JudgingProfileLib = {
    buildModel: buildModel,
    renderPaneHTML: renderPaneHTML,
    updatePanelBars: updatePanelBars,
    sortProfilesByMetric: sortProfilesByMetric,
    renderInnerBars: renderInnerBars,
    profileMetricValue: profileMetricValue,
    LOW_SAMPLE_MAX: LOW_SAMPLE_MAX,
  };
})(typeof window !== "undefined" ? window : this);
