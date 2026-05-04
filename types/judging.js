/**
 * JSDoc type shapes for Judging Profile (reference for TS migration / editors).
 * Not executed.
 *
 * @typedef {Object} SelectedCompetitionContext
 * @property {string} competitionId
 * @property {string} competitionName
 * @property {string} competitionDate
 * @property {string} [competitionLogoUrl]
 */

/**
 * @typedef {Object} ScoreEntry
 * @property {string} competitionName
 * @property {string} competitionDate
 * @property {number} compNo
 * @property {string} danceName
 * @property {string} [dancerName]
 * @property {string} level
 * @property {string} category
 * @property {string} age
 * @property {string} style
 * @property {number} [judge1Technique]
 * @property {number} [avgTechnique]
 * @property {number} [avgChoreo]
 * @property {number} [grandTotal]
 */

/**
 * @typedef {Object} CompetitionAverages
 * @property {number} totalEntries
 * @property {number} avgGrandTotal
 * @property {number} avgTechnique
 * @property {number} avgChoreo
 */

/**
 * @typedef {Object} AxisProfile
 * @property {string} label
 * @property {number} entryCount
 * @property {number} avgTotal
 * @property {number} avgTechnique
 * @property {number} avgChoreo
 * @property {number} [deltaFromCompAvg]
 */

/**
 * @typedef {Object} JudgeTopGenre
 * @property {string} genre
 * @property {number} avgTechnique
 */

/**
 * @typedef {Object} JudgeProfile
 * @property {string} judgeId
 * @property {number} avgTechnique
 * @property {number} avgChoreo
 * @property {JudgeTopGenre[]} topGenresByTechnique
 * @property {'Balanced'|'Technique-Leaning'|'Performance-Leaning'} scoringStyle
 */

/**
 * @typedef {Object} PanelConsistencySummary
 * @property {string} label
 * @property {string} shortDescription
 * @property {number} [value]
 */

/**
 * Peer percentile block (Grand Total, same Level & Category; row excluded from peer list).
 * Built in index.html by computePeerPercentileStats.
 *
 * @typedef {Object} PeerPercentileStats
 * @property {string} pctStr — Display percentile 0.0–100.0 (clamped cohort mapped to 1–99%).
 * @property {number} pct
 * @property {number} n — Count of *other* scored peers in the pool.
 * @property {number} nTotal — n + 1 (this routine included in cohort size for rank).
 * @property {number} rankMid — 1-based mid-rank among all nTotal scores (ties averaged); 1 = best (highest Grand Total).
 * @property {string} pctBeatPeersStr — Share of peers strictly below this Grand Total, 0.0–100.0.
 */