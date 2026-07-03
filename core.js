// ============================================================
// MOP Planner — Core calculation engine
// Pure functions, no DOM. Works as a plain <script> in the browser
// (attaches window.MOPCore) and via require() in Node tests.
// ============================================================
(function (global) {
  'use strict';

  // ---------- Master config ----------
  // NOTE: 5 of the 27 cities (Jalgaon, Solapur, Faridabad, Agra,
  // Coimbatore) were added to the master list without a stated
  // cluster. Clusters below are a best-guess placement (by
  // geography, matching the existing cluster set) and should be
  // confirmed — they only affect the optional cluster rollup, not
  // any calculation.
  var CITIES = [
    { name: 'Ahmedabad', cluster: 'Gujarat' },
    { name: 'Nagpur', cluster: 'MH East' },
    { name: 'Amravati', cluster: 'MH East' },
    { name: 'Aurangabad', cluster: 'MH West' },
    { name: 'Nashik', cluster: 'MH West' },
    { name: 'Pune', cluster: 'MH West' },
    { name: 'Kolhapur', cluster: 'MH West' },
    { name: 'Jalgaon', cluster: 'MH West' },
    { name: 'Solapur', cluster: 'MH West' },
    { name: 'Bhopal', cluster: 'MP' },
    { name: 'Gwalior', cluster: 'MP' },
    { name: 'Indore', cluster: 'MP' },
    { name: 'Jabalpur', cluster: 'MP' },
    { name: 'Jaipur', cluster: 'Rajasthan' },
    { name: 'Delhi', cluster: 'NCR' },
    { name: 'Faridabad', cluster: 'NCR' },
    { name: 'Gurgaon', cluster: 'NCR' },
    { name: 'Ghaziabad', cluster: 'NCR' },
    { name: 'Noida', cluster: 'NCR' },
    { name: 'Agra', cluster: 'UP' },
    { name: 'Kanpur', cluster: 'UP' },
    { name: 'Lucknow', cluster: 'UP' },
    { name: 'Varanasi', cluster: 'UP' },
    { name: 'Hyderabad', cluster: 'Telangana' },
    { name: 'Bangalore', cluster: 'Karnataka' },
    { name: 'Chennai', cluster: 'Tamil Nadu' },
    { name: 'Coimbatore', cluster: 'Tamil Nadu' }
  ];

  // Current data taxonomy (matches referral_effort.json today).
  // Kept as one list so re-mapping to the new taxonomy later
  // (Sales / WhatsApp / Ops / AMC / Customer App / BTL / Others)
  // is a config edit here, not a rebuild.
  var SUB_CHANNELS = ['Sales', 'Online', 'Ops / AMC', 'Customer_App', 'Referral_Others'];
  var BTL_CHANNEL = 'BTL'; // tracked, shown, excluded from every projection

  var FIELD_OPTIONS = {
    bql: ['BQL_New', 'BQL_Old'],
    ms: ['First_MS', 'Total_MS'],
    md: ['First_MD', 'Total_MD']
  };

  var DEFAULT_SETTINGS = {
    bqlField: 'BQL_New',
    msField: 'First_MS',
    mdField: 'First_MD',
    trailingMonths: 3,
    orderHotoMode: 'policy', // 'policy' | 'trend'
    orderHotoPolicyRate: 0.95,
    campaignMonths: ['2025-12', '2026-03', '2026-04', '2026-06']
  };

  var DAYS_IN_MONTH = { 1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };

  function daysInMonth(year, month) {
    if (month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return 29;
    return DAYS_IN_MONTH[month];
  }

  function monthKey(year, month) { return year + '-' + String(month).padStart(2, '0'); }

  function parseMonthKey(key) {
    var parts = key.split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) };
  }

  function addMonths(key, offset) {
    var p = parseMonthKey(key);
    var idx = (p.year * 12 + (p.month - 1)) + offset;
    var y = Math.floor(idx / 12);
    var m = (idx % 12) + 1;
    return monthKey(y, m);
  }

  function parseActionDate(str) {
    var parts = str.split('/');
    return { day: parseInt(parts[0], 10), month: parseInt(parts[1], 10), year: parseInt(parts[2], 10) };
  }

  function normalizeCity(name) { return (name || '').trim(); }

  function filterRows(rows, opts) {
    opts = opts || {};
    var cityFilter = opts.cities ? new Set(opts.cities) : null;
    var subChannelFilter = opts.subChannels ? new Set(opts.subChannels) : null;
    return rows.filter(function (r) {
      if (cityFilter && !cityFilter.has(normalizeCity(r.city))) return false;
      if (subChannelFilter && !subChannelFilter.has(r.sub_channel)) return false;
      return true;
    });
  }

  function emptyTotals() {
    return { BQL_Old: 0, BQL_New: 0, First_MS: 0, Total_MS: 0, First_MD: 0, Total_MD: 0, Order: 0, HOTO: 0 };
  }

  function addRowTo(totals, r) {
    totals.BQL_Old += r.BQL_Old || 0;
    totals.BQL_New += r.BQL_New || 0;
    totals.First_MS += r.First_MS || 0;
    totals.Total_MS += r.Total_MS || 0;
    totals.First_MD += r.First_MD || 0;
    totals.Total_MD += r.Total_MD || 0;
    totals.Order += r.Order || 0;
    totals.HOTO += r.HOTO || 0;
  }

  function sumMonth(rows, year, month, upToDay) {
    var totals = emptyTotals();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.year !== year || r.month !== month) continue;
      if (upToDay != null) {
        var d = parseActionDate(r.action_date);
        if (d.day > upToDay) continue;
      }
      addRowTo(totals, r);
    }
    return totals;
  }

  function pick(totals, field) { return totals[field] || 0; }

  function getMonthFigure(rows, year, month, asOf) {
    var lastDay = daysInMonth(year, month);
    var monthIsFuture = (year > asOf.year) || (year === asOf.year && month > asOf.month);
    var monthIsPast = (year < asOf.year) || (year === asOf.year && month < asOf.month);

    if (monthIsFuture) {
      return { totals: null, isEstimated: null, daysElapsed: 0, daysInMonth: lastDay };
    }
    if (monthIsPast) {
      return { totals: sumMonth(rows, year, month, null), isEstimated: false, daysElapsed: lastDay, daysInMonth: lastDay };
    }
    var daysElapsed = Math.min(asOf.day, lastDay);
    var soFar = sumMonth(rows, year, month, daysElapsed);
    var pace = daysElapsed > 0 ? (lastDay / daysElapsed) : 0;
    var projected = emptyTotals();
    Object.keys(projected).forEach(function (k) { projected[k] = soFar[k] * pace; });
    return { totals: projected, isEstimated: true, daysElapsed: daysElapsed, daysInMonth: lastDay, actualSoFar: soFar };
  }

  function avg(arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; }

  function projectVolume(series) {
    if (series.length === 0) return 0;
    if (series.length === 1) return series[0];
    var level = avg(series);
    var deltas = [];
    for (var i = 1; i < series.length; i++) {
      if (series[i - 1] > 0) deltas.push((series[i] - series[i - 1]) / series[i - 1]);
    }
    var momentum = deltas.length ? avg(deltas) : 0;
    return level * (1 + momentum);
  }

  function projectRate(series) {
    if (series.length === 0) return 0;
    if (series.length === 1) return Math.max(0, series[0]);
    var level = avg(series);
    var deltas = [];
    for (var i = 1; i < series.length; i++) deltas.push(series[i] - series[i - 1]);
    var momentum = deltas.length ? avg(deltas) : 0;
    return Math.max(0, level + momentum);
  }

  function safeRate(num, den) { return den > 0 ? num / den : 0; }

  function buildTrailingSeries(rows, planningMonth, n, asOf) {
    var months = [];
    for (var i = n; i >= 1; i--) {
      var mk = addMonths(planningMonth, -i);
      var p = parseMonthKey(mk);
      var fig = getMonthFigure(rows, p.year, p.month, asOf);
      months.push({ monthKey: mk, figure: fig });
    }
    return months;
  }

  var CHAIN = ['BQL', 'r1', 'MS', 'r2', 'MD', 'r3', 'Order', 'r4', 'HOTO'];

  function resolveFunnel(base, overrides) {
    overrides = overrides || {};
    var state = {};
    var flags = {};
    var vol = null;
    for (var i = 0; i < CHAIN.length; i++) {
      var key = CHAIN[i];
      var isVolume = (i % 2 === 0);
      if (isVolume) {
        if (key === 'BQL') {
          state.BQL = (overrides.BQL != null) ? overrides.BQL : base.BQL;
          flags.BQL = overrides.BQL != null;
          vol = state.BQL;
        } else {
          var rateKey = CHAIN[i - 1];
          if (overrides[key] != null) {
            state[key] = overrides[key];
            flags[key] = true;
            if (overrides[rateKey] == null) {
              state[rateKey] = safeRate(state[key], vol);
              flags[rateKey] = 'derived';
            }
          } else {
            var rate = (overrides[rateKey] != null) ? overrides[rateKey] : state[rateKey];
            state[key] = vol * rate;
            flags[key] = false;
          }
          vol = state[key];
        }
      } else {
        if (state[key] == null) {
          state[key] = (overrides[key] != null) ? overrides[key] : base[key];
          flags[key] = overrides[key] != null;
        }
      }
    }
    return { state: state, flags: flags };
  }

  function trailingShares(seriesByKey) {
    var levels = {};
    var total = 0;
    Object.keys(seriesByKey).forEach(function (k) {
      var lvl = avg(seriesByKey[k]);
      levels[k] = lvl;
      total += lvl;
    });
    var shares = {};
    Object.keys(levels).forEach(function (k) {
      shares[k] = total > 0 ? levels[k] / total : 0;
    });
    return shares;
  }

  // ---------- High-level orchestration ----------
  // Builds the trailing-n series for BQL and the 4 rates for a given
  // row subset, using the configured field mapping, and returns a
  // "base" funnel object ready to feed into resolveFunnel(), plus the
  // raw series (for charting / transparency) and which months were
  // campaign-tagged.
  function projectFunnelForRows(rows, planningMonth, settings, asOf, orderHotoOverrideRate) {
    var n = settings.trailingMonths;
    var months = buildTrailingSeries(rows, planningMonth, n, asOf);
    var bqlSeries = [], r1Series = [], r2Series = [], r3Series = [], r4Series = [];
    var monthMeta = [];
    months.forEach(function (m) {
      var t = m.figure.totals;
      var bql = pick(t, settings.bqlField);
      var ms = pick(t, settings.msField);
      var md = pick(t, settings.mdField);
      var ord = pick(t, 'Order');
      var hoto = pick(t, 'HOTO');
      bqlSeries.push(bql);
      r1Series.push(safeRate(ms, bql));
      r2Series.push(safeRate(md, ms));
      r3Series.push(safeRate(ord, md));
      r4Series.push(safeRate(hoto, ord));
      monthMeta.push({
        monthKey: m.monthKey,
        isCampaign: settings.campaignMonths.indexOf(m.monthKey) !== -1,
        isEstimated: m.figure.isEstimated,
        bql: bql
      });
    });

    var base = {
      BQL: projectVolume(bqlSeries),
      r1: projectRate(r1Series),
      r2: projectRate(r2Series),
      r3: projectRate(r3Series)
    };
    var trendR4 = projectRate(r4Series);
    base.r4 = (settings.orderHotoMode === 'policy')
      ? (orderHotoOverrideRate != null ? orderHotoOverrideRate : settings.orderHotoPolicyRate)
      : trendR4;

    base.MS = base.BQL * base.r1;
    base.MD = base.MS * base.r2;
    base.Order = base.MD * base.r3;
    base.HOTO = base.Order * base.r4;

    return {
      base: base,
      trendR4: trendR4,
      series: { bql: bqlSeries, r1: r1Series, r2: r2Series, r3: r3Series, r4: r4Series },
      months: monthMeta
    };
  }

  // Per-city / per-sub-channel share of BQL, trailing-n average, normalized.
  function computeShares(rows, keys, keyField, planningMonth, n, asOf, bqlField) {
    var seriesByKey = {};
    keys.forEach(function (k) {
      var subset = rows.filter(function (r) { return (keyField === 'city' ? normalizeCity(r.city) : r.sub_channel) === k; });
      var months = buildTrailingSeries(subset, planningMonth, n, asOf);
      seriesByKey[k] = months.map(function (m) { return pick(m.figure.totals, bqlField); });
    });
    return trailingShares(seriesByKey);
  }

  // Applies a list of initiatives (already filtered to the relevant
  // scope by the caller) on top of a base funnel object, in order,
  // each one recomputing the chain forward from whatever it touched.
  // initiative = { metric: 'BQL'|'r1'|'MS'|...|'HOTO', impactType: 'percent'|'absolute', impactValue: number }
  // For rate metrics (r1-r4), 'absolute' impactValue is in percentage
  // points (e.g. 2 means +0.02).
  function applyInitiativesToBase(base, initiatives) {
    var current = Object.assign({}, base);
    (initiatives || []).forEach(function (init) {
      var isRate = (init.metric === 'r1' || init.metric === 'r2' || init.metric === 'r3' || init.metric === 'r4');
      var currentVal = current[init.metric];
      var newVal;
      if (init.impactType === 'percent') {
        newVal = currentVal * (1 + init.impactValue / 100);
      } else {
        newVal = currentVal + (isRate ? init.impactValue / 100 : init.impactValue);
      }
      var overrideObj = {};
      overrideObj[init.metric] = newVal;
      current = resolveFunnel(current, overrideObj).state;
    });
    return current;
  }

  var MOPCore = {
    CITIES: CITIES,
    SUB_CHANNELS: SUB_CHANNELS,
    BTL_CHANNEL: BTL_CHANNEL,
    FIELD_OPTIONS: FIELD_OPTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    daysInMonth: daysInMonth,
    monthKey: monthKey,
    parseMonthKey: parseMonthKey,
    addMonths: addMonths,
    parseActionDate: parseActionDate,
    normalizeCity: normalizeCity,
    filterRows: filterRows,
    emptyTotals: emptyTotals,
    sumMonth: sumMonth,
    pick: pick,
    getMonthFigure: getMonthFigure,
    avg: avg,
    projectVolume: projectVolume,
    projectRate: projectRate,
    safeRate: safeRate,
    buildTrailingSeries: buildTrailingSeries,
    resolveFunnel: resolveFunnel,
    trailingShares: trailingShares,
    projectFunnelForRows: projectFunnelForRows,
    computeShares: computeShares,
    applyInitiativesToBase: applyInitiativesToBase,
    CHAIN: CHAIN
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MOPCore;
  } else {
    global.MOPCore = MOPCore;
  }

})(typeof window !== 'undefined' ? window : globalThis);
