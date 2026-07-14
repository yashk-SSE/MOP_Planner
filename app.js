/* global MOPCore */
(function () {
  'use strict';

  var DATA_URL = 'https://raw.githubusercontent.com/yashk-SSE/Referral-Dashboard/main/data/referral_effort.json';
  var CITY_NAMES = MOPCore.CITIES.map(function (c) { return c.name; });
  var CLUSTER_OF = {}; MOPCore.CITIES.forEach(function (c) { CLUSTER_OF[c.name] = c.cluster; });
  var METRIC_LABELS = { BQL: 'BQL', r1: 'BQL\u2192MS %', MS: 'MS', r2: 'MS\u2192MD %', MD: 'MD', r3: 'MD\u2192Order %', Order: 'Order', r4: 'Order\u2192HOTO %', HOTO: 'HOTO' };
  var RATE_KEYS = ['r1', 'r2', 'r3', 'r4'];
  var VOL_KEYS = ['BQL', 'MS', 'MD', 'Order', 'HOTO'];

  var state = {
    rows: null,
    dataLoadedNote: '',
    settings: Object.assign({}, MOPCore.DEFAULT_SETTINGS),
    planningMonth: null,
    asOf: null,
    overrides: { panIndia: {}, city: {}, subChannel: {}, cell: {} },
    initiatives: [],
    activeTab: 'summary',
    gitHubToken: localStorage.getItem('mop_gh_token') || '',
    gitHubOwner: localStorage.getItem('mop_gh_owner') || 'yashk-SSE',
    gitHubRepo: localStorage.getItem('mop_gh_repo') || 'MOP_Planner',
    versions: []
  };

  function fmt0(n) { return Math.round(n).toLocaleString('en-IN'); }
  function fmtPct(n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; }
  function asOfToMonthInput(asOf) { return asOf.year + '-' + String(asOf.month).padStart(2, '0') + '-' + String(asOf.day).padStart(2, '0'); }

  // ---------------- Data loading ----------------
  function loadData() {
    setStatus('Loading referral_effort.json from GitHub\u2026', false);
    fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) {
      onDataLoaded(rows, 'Loaded from ' + DATA_URL);
    }).catch(function (err) {
      setStatus('Could not load from GitHub (' + err.message + '). Upload referral_effort.json manually below, or check the repo/path.', true);
      showUploadFallback();
    });
  }

  function showUploadFallback() {
    var wrap = document.getElementById('upload-fallback');
    wrap.style.display = 'block';
    document.getElementById('file-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var rows = JSON.parse(reader.result);
          onDataLoaded(rows, 'Loaded from uploaded file: ' + file.name);
          wrap.style.display = 'none';
        } catch (err) {
          setStatus('Could not parse that file as JSON: ' + err.message, true);
        }
      };
      reader.readAsText(file);
    });
  }

  function onDataLoaded(rows, note) {
    state.rows = rows;
    var dates = rows.map(function (r) { return MOPCore.parseActionDate(r.action_date); })
      .map(function (d) { return d.year * 10000 + d.month * 100 + d.day; });
    var maxD = Math.max.apply(null, dates);
    var y = Math.floor(maxD / 10000), m = Math.floor((maxD % 10000) / 100), d = maxD % 100;
    state.asOf = { year: y, month: m, day: d };
    state.planningMonth = MOPCore.addMonths(MOPCore.monthKey(y, m), 1);
    setStatus(note + ' \u00b7 ' + rows.length.toLocaleString('en-IN') + ' rows \u00b7 latest date ' + d + '/' + m + '/' + y, false);
    initControlsFromState();
    computeAndRender();
  }

  function setStatus(msg, isError) {
    var el = document.getElementById('data-status');
    el.innerHTML = (isError ? '' : '<span class="dot"></span>') + msg;
    el.className = 'data-status' + (isError ? ' error' : '');
  }

  // ---------------- Computation ----------------
  var last = null;

  function getUniverseRows() {
    return MOPCore.filterRows(state.rows, { cities: CITY_NAMES, subChannels: MOPCore.SUB_CHANNELS });
  }

  function initiativesFor(scope, cityName, subChannelName) {
    return state.initiatives.filter(function (it) {
      if (it.scope === 'all') return true;
      if (it.scope === 'city') return scope === 'city' && it.scopeCity === cityName;
      if (it.scope === 'subChannel') return scope === 'subChannel' && it.scopeSubChannel === subChannelName;
      return false;
    });
  }

  function computeAll() {
    var universe = getUniverseRows();
    var s = state.settings;
    var asOf = state.asOf;
    var pm = state.planningMonth;

    var panProj = MOPCore.projectFunnelForRows(universe, s, asOf, pm);
    var panBase = MOPCore.applyInitiativesToBase(panProj.base, initiativesFor('all'));
    var panResolved = MOPCore.resolveFunnel(panBase, state.overrides.panIndia);

    var cityShares = MOPCore.computeShares(universe, CITY_NAMES, 'city', s.trailingMonths, asOf, s.bqlField, s.minDaysForCurrentMonth);
    var subShares = MOPCore.computeShares(universe, MOPCore.SUB_CHANNELS, 'subChannel', s.trailingMonths, asOf, s.bqlField, s.minDaysForCurrentMonth);

    var cities = {};
    CITY_NAMES.forEach(function (city) {
      var cityRows = MOPCore.filterRows(universe, { cities: [city] });
      var proj = MOPCore.projectFunnelForRows(cityRows, s, asOf, pm, panResolved.state.r4);
      var base = MOPCore.applyInitiativesToBase(proj.base, initiativesFor('city', city));
      var shareBQL = panResolved.state.BQL * (cityShares[city] || 0);
      var withShare = MOPCore.resolveFunnel(base, { BQL: shareBQL }).state;
      var resolved = MOPCore.resolveFunnel(withShare, state.overrides.city[city] || {});
      cities[city] = { base: base, ownTrendBQL: proj.base.BQL, share: cityShares[city] || 0, resolved: resolved, proj: proj };
    });

    var subChannels = {};
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var scRows = MOPCore.filterRows(universe, { subChannels: [sc] });
      var proj = MOPCore.projectFunnelForRows(scRows, s, asOf, pm, panResolved.state.r4);
      var base = MOPCore.applyInitiativesToBase(proj.base, initiativesFor('subChannel', null, sc));
      var shareBQL = panResolved.state.BQL * (subShares[sc] || 0);
      var withShare = MOPCore.resolveFunnel(base, { BQL: shareBQL }).state;
      var resolved = MOPCore.resolveFunnel(withShare, state.overrides.subChannel[sc] || {});
      subChannels[sc] = { base: base, share: subShares[sc] || 0, resolved: resolved, proj: proj };
    });

    var btlRows = MOPCore.filterRows(state.rows, { cities: CITY_NAMES, subChannels: [MOPCore.BTL_CHANNEL] });
    var referenceMonth = MOPCore.getReferenceMonth(asOf, s.minDaysForCurrentMonth);
    var lp = MOPCore.parseMonthKey(referenceMonth);
    var btlFig = { totals: MOPCore.sumMonth(btlRows, lp.year, lp.month, null) };
    // BTL is excluded from every real projection by design, but the Historical
    // tab lets you optionally view its raw trend alongside the other channels.
    var btlHistProj = MOPCore.projectFunnelForRows(btlRows, s, asOf, pm);

    var cross = {};
    CITY_NAMES.forEach(function (city) {
      var cityRows = MOPCore.filterRows(universe, { cities: [city] });
      var withinShares = MOPCore.computeShares(cityRows, MOPCore.SUB_CHANNELS, 'subChannel', s.trailingMonths, asOf, s.bqlField, s.minDaysForCurrentMonth);
      var cityFinal = cities[city].resolved.state;
      var weights = {}, weightSum = 0;
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        var cellRows = MOPCore.filterRows(universe, { cities: [city], subChannels: [sc] });
        var months = MOPCore.buildTrailingSeries(cellRows, asOf, s.trailingMonths, s.minDaysForCurrentMonth);
        var ratios = months.map(function (mo) {
          var t = mo.totals;
          return MOPCore.safeRate(MOPCore.pick(t, 'Order'), MOPCore.pick(t, s.bqlField));
        });
        var avgRatio = MOPCore.avg(ratios) || 0;
        var bqlCell = cityFinal.BQL * (withinShares[sc] || 0);
        var w = avgRatio * bqlCell;
        weights[sc] = { bqlCell: bqlCell, w: w };
        weightSum += w;
      });
      cross[city] = {};
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        var bqlCell = weights[sc].bqlCell;
        var orderCell = weightSum > 0 ? (weights[sc].w / weightSum) * cityFinal.Order : 0;
        var key = city + '|' + sc;
        var ov = state.overrides.cell[key] || {};
        if (ov.BQL != null) bqlCell = ov.BQL;
        if (ov.Order != null) orderCell = ov.Order;
        var hotoCell = orderCell * panResolved.state.r4;
        cross[city][sc] = { BQL: bqlCell, Order: orderCell, HOTO: hotoCell, overridden: { BQL: ov.BQL != null, Order: ov.Order != null } };
      });
    });

    last = {
      panIndia: panResolved, panProj: panProj, cities: cities, subChannels: subChannels,
      cross: cross, btl: btlFig, btlHistProj: btlHistProj, cityShares: cityShares, subShares: subShares
    };
    return last;
  }

  function computeAndRender() {
    if (!state.rows) return;
    computeAll();
    renderSummary();
    renderCities();
    renderSubChannels();
    renderCross();
    renderHistorical();
    renderInitiatives();
  }

  // ---------------- Editable cell helper ----------------
  function makeEditable(el, getValue, isPercent, onCommit, onClear) {
    el.classList.add('cell-editable');
    el.addEventListener('click', function () {
      if (el.querySelector('input')) return;
      var raw = getValue();
      var display = isPercent ? (raw * 100).toFixed(1) : Math.round(raw);
      el.innerHTML = '';
      var input = document.createElement('input');
      input.type = 'text';
      input.value = display;
      input.style.width = '76px';
      input.style.textAlign = 'right';
      el.appendChild(input);
      input.focus();
      input.select();
      function commit() {
        var v = input.value.trim();
        if (v === '') { onClear(); } else {
          var num = parseFloat(v);
          if (!isNaN(num)) onCommit(isPercent ? num / 100 : num);
        }
        computeAndRender();
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { commit(); }
        if (e.key === 'Escape') { computeAndRender(); }
      });
      input.addEventListener('blur', commit);
    });
  }

  function lastVal(series) { return series[series.length - 1]; }

  // ---------------- Rendering: Summary ----------------
  function renderSummary() {
    var r = last.panIndia.state, flags = last.panIndia.flags;
    var prevMonthKey = last.panProj.months[last.panProj.months.length - 1].monthKey;
    var steps = last.panProj.steps;
    var planBanner = document.getElementById('plan-banner');
    planBanner.innerHTML = 'Projecting <strong>' + state.planningMonth + '</strong>' +
      (steps > 1 ? ' &mdash; ' + steps + ' months ahead of the last usable data (' + last.panProj.referenceMonth + '), so momentum is extrapolated ' + steps + ' steps forward' : ' &mdash; 1 month ahead of the last usable data (' + last.panProj.referenceMonth + ')');
    var cardGrid = document.getElementById('summary-cards');
    cardGrid.innerHTML = '';
    var seriesKeyFor = { BQL: 'bql', MS: 'ms', MD: 'md', Order: 'order', HOTO: 'hoto' };
    VOL_KEYS.forEach(function (k) {
      var prev = lastVal(last.panProj.series[seriesKeyFor[k]]);
      var card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = '<div class="label">' + METRIC_LABELS[k] + '</div>' +
        '<div class="value ' + (flags[k] ? 'overridden' : '') + '">' + fmt0(r[k]) + '<span class="ref-prev">(' + fmt0(prev) + ')</span></div>' +
        '<div class="delta">' + (flags[k] === 'derived' ? 'rate back-solved from override' : (flags[k] ? 'manually overwritten' : 'projected \u00b7 ' + prevMonthKey + ' in brackets')) + '</div>';
      var valEl = card.querySelector('.value');
      makeEditable(valEl, function () { return r[k]; }, false,
        function (v) { state.overrides.panIndia[k] = v; },
        function () { delete state.overrides.panIndia[k]; });
      cardGrid.appendChild(card);
    });

    var rateGrid = document.getElementById('summary-rates');
    rateGrid.innerHTML = '';
    RATE_KEYS.forEach(function (k) {
      var prev = lastVal(last.panProj.series[k]);
      var card = document.createElement('div');
      card.className = 'rate-card';
      var refNote = '';
      if (k === 'r4') {
        refNote = state.settings.orderHotoMode === 'policy'
          ? 'policy value \u00b7 trend ref ' + fmtPct(last.panProj.trendR4)
          : 'trend-based';
      } else {
        refNote = 'organic trend (n=' + state.settings.trailingMonths + ')';
      }
      card.innerHTML = '<div class="label">' + METRIC_LABELS[k] + '</div>' +
        '<div class="value ' + (flags[k] ? 'overridden' : '') + '"></div>' +
        '<div class="ref">' + refNote + '</div>';
      var valEl = card.querySelector('.value');
      valEl.innerHTML = fmtPct(r[k]) + '<span class="ref-prev">(' + fmtPct(prev) + ')</span>';
      makeEditable(valEl, function () { return r[k]; }, true,
        function (v) { state.overrides.panIndia[k] = v; },
        function () { delete state.overrides.panIndia[k]; });
      rateGrid.appendChild(card);
    });

    var strip = document.getElementById('month-strip');
    strip.innerHTML = '';
    last.panProj.months.forEach(function (m) {
      var chip = document.createElement('div');
      chip.className = 'month-chip';
      chip.innerHTML = '<span>' + m.monthKey + '</span>' +
        (m.isCampaign ? '<span class="tag">campaign</span>' : '') +
        (m.isEstimated ? '<span class="tag est">seasonally est.</span>' : '') +
        '<span>BQL ' + fmt0(m.bql) + '</span>';
      strip.appendChild(chip);
    });

    var paceWrap = document.getElementById('current-pace');
    var ip = last.panProj.inProgress;
    if (ip) {
      paceWrap.style.display = 'block';
      paceWrap.innerHTML = '<p class="hint" style="margin:0 0 8px;"><strong>' + ip.monthKey + '</strong> has only ' + ip.daysElapsed + ' of ' + ip.daysInMonth + ' days of data \u2014 below the ' + ip.threshold + '-day minimum to trust even a seasonally-adjusted estimate, so it\u2019s excluded from the trend above (shown here for context only). Once it reaches day ' + ip.threshold + ', it will automatically join the trend as an estimated month.</p>' +
        '<div class="month-strip">' +
        ['bql', 'ms', 'md', 'ord', 'hoto'].map(function (k) {
          var label = { bql: 'BQL', ms: 'MS', md: 'MD', ord: 'Order', hoto: 'HOTO' }[k];
          var p = ip.pace[k];
          return '<div class="month-chip"><span>' + label + '</span><span>' + fmt0(p.actualSoFar) + ' so far \u2192 est. ' + fmt0(p.projected) + '</span></div>';
        }).join('') + '</div>';
    } else {
      paceWrap.style.display = 'none';
    }
  }

  // ---------------- Rendering: Cities ----------------
  var SERIES_KEY_FOR = { BQL: 'bql', MS: 'ms', MD: 'md', Order: 'order', HOTO: 'hoto' };

  function renderCities() {
    var tbody = document.getElementById('cities-tbody');
    tbody.innerHTML = '';
    var byCluster = {};
    MOPCore.CITIES.forEach(function (c) { (byCluster[c.cluster] = byCluster[c.cluster] || []).push(c.name); });
    var totals = { BQL: 0, MS: 0, MD: 0, Order: 0, HOTO: 0 };

    Object.keys(byCluster).forEach(function (cluster) {
      var trCluster = document.createElement('tr');
      trCluster.className = 'cluster-row';
      trCluster.innerHTML = '<td colspan="12">' + cluster + '</td>';
      tbody.appendChild(trCluster);

      byCluster[cluster].forEach(function (city) {
        var c = last.cities[city];
        var st = c.resolved.state, fl = c.resolved.flags, sr = c.proj.series;
        VOL_KEYS.forEach(function (k) { totals[k] += st[k]; });
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td>' + city + '</td>' +
          VOL_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmt0(st[k]) + '<span class="ref-prev-cell">(' + fmt0(lastVal(sr[SERIES_KEY_FOR[k]])) + ')</span></td>'; }).join('') +
          RATE_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmtPct(st[k]) + '<span class="ref-prev-cell">(' + fmtPct(lastVal(sr[k])) + ')</span></td>'; }).join('') +
          '<td>' + fmtPct(MOPCore.safeRate(st.HOTO, st.BQL)) + '</td>';
        VOL_KEYS.forEach(function (k) {
          var td = tr.querySelector('td[data-k="' + k + '"]');
          makeEditable(td, function () { return last.cities[city].resolved.state[k]; }, false,
            function (v) { (state.overrides.city[city] = state.overrides.city[city] || {})[k] = v; },
            function () { if (state.overrides.city[city]) delete state.overrides.city[city][k]; });
        });
        RATE_KEYS.forEach(function (k) {
          var td = tr.querySelector('td[data-k="' + k + '"]');
          makeEditable(td, function () { return last.cities[city].resolved.state[k]; }, true,
            function (v) { (state.overrides.city[city] = state.overrides.city[city] || {})[k] = v; },
            function () { if (state.overrides.city[city]) delete state.overrides.city[city][k]; });
        });
        tbody.appendChild(tr);
      });
    });

    var trTotal = document.createElement('tr');
    trTotal.className = 'total-row';
    trTotal.innerHTML = '<td></td><td>Total (27 cities)</td>' +
      VOL_KEYS.map(function (k) { return '<td>' + fmt0(totals[k]) + '</td>'; }).join('') +
      RATE_KEYS.map(function (k) {
        var num = k === 'r1' ? totals.MS : k === 'r2' ? totals.MD : k === 'r3' ? totals.Order : totals.HOTO;
        var den = k === 'r1' ? totals.BQL : k === 'r2' ? totals.MS : k === 'r3' ? totals.MD : totals.Order;
        return '<td>' + fmtPct(MOPCore.safeRate(num, den)) + '</td>';
      }).join('') +
      '<td>' + fmtPct(MOPCore.safeRate(totals.HOTO, totals.BQL)) + '</td>';
    tbody.appendChild(trTotal);

    var panBQL = last.panIndia.state.BQL;
    document.getElementById('cities-reconcile').textContent =
      'Sum of 27 cities BQL: ' + fmt0(totals.BQL) + ' \u00b7 Pan-India projected BQL: ' + fmt0(panBQL) +
      ' (should match \u2014 city BQL is share-derived from this same pan-India number, not independently trended). Bracketed numbers are last month\u2019s figure for reference.';
  }

  // ---------------- Rendering: Sub-channels ----------------
  function renderSubChannels() {
    var tbody = document.getElementById('subchannels-tbody');
    tbody.innerHTML = '';
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var c = last.subChannels[sc];
      var st = c.resolved.state, fl = c.resolved.flags, sr = c.proj.series;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + sc + '</td>' +
        VOL_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmt0(st[k]) + '<span class="ref-prev-cell">(' + fmt0(lastVal(sr[SERIES_KEY_FOR[k]])) + ')</span></td>'; }).join('') +
        RATE_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmtPct(st[k]) + '<span class="ref-prev-cell">(' + fmtPct(lastVal(sr[k])) + ')</span></td>'; }).join('') +
        '<td>' + fmtPct(MOPCore.safeRate(st.HOTO, st.BQL)) + '</td>';
      VOL_KEYS.forEach(function (k) {
        var td = tr.querySelector('td[data-k="' + k + '"]');
        makeEditable(td, function () { return last.subChannels[sc].resolved.state[k]; }, false,
          function (v) { (state.overrides.subChannel[sc] = state.overrides.subChannel[sc] || {})[k] = v; },
          function () { if (state.overrides.subChannel[sc]) delete state.overrides.subChannel[sc][k]; });
      });
      RATE_KEYS.forEach(function (k) {
        var td = tr.querySelector('td[data-k="' + k + '"]');
        makeEditable(td, function () { return last.subChannels[sc].resolved.state[k]; }, true,
          function (v) { (state.overrides.subChannel[sc] = state.overrides.subChannel[sc] || {})[k] = v; },
          function () { if (state.overrides.subChannel[sc]) delete state.overrides.subChannel[sc][k]; });
      });
      tbody.appendChild(tr);
    });

    var btlRow = document.createElement('tr');
    btlRow.className = 'btl-row';
    var b = last.btl.totals;
    btlRow.innerHTML = '<td>BTL (excluded from projection)</td>' +
      '<td>' + fmt0(MOPCore.pick(b, state.settings.bqlField)) + '</td>' +
      '<td>' + fmt0(MOPCore.pick(b, state.settings.msField)) + '</td>' +
      '<td>' + fmt0(MOPCore.pick(b, state.settings.mdField)) + '</td>' +
      '<td>' + fmt0(b.Order) + '</td><td>' + fmt0(b.HOTO) + '</td>' +
      '<td colspan="5">last completed month actual, shown for reference only</td>';
    tbody.appendChild(btlRow);
  }

  // ---------------- Rendering: Cross tab ----------------
  function renderCross() {
    var thead = document.getElementById('cross-thead');
    var tbody = document.getElementById('cross-tbody');
    thead.innerHTML = '<tr><th></th>' + MOPCore.SUB_CHANNELS.map(function (sc) { return '<th colspan="3">' + sc + '</th>'; }).join('') + '<th colspan="3">City total</th></tr>' +
      '<tr><th>City</th>' + MOPCore.SUB_CHANNELS.map(function () { return '<th>BQL</th><th>Order</th><th>HOTO</th>'; }).join('') + '<th>BQL</th><th>Order</th><th>HOTO</th></tr>';
    tbody.innerHTML = '';
    CITY_NAMES.forEach(function (city) {
      var tr = document.createElement('tr');
      var cellsHtml = '<td>' + city + '</td>';
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        var cell = last.cross[city][sc];
        cellsHtml += '<td data-city="' + city + '" data-sc="' + sc + '" data-k="BQL" class="' + (cell.overridden.BQL ? 'cell-overridden' : '') + '">' + fmt0(cell.BQL) + '</td>';
        cellsHtml += '<td data-city="' + city + '" data-sc="' + sc + '" data-k="Order" class="' + (cell.overridden.Order ? 'cell-overridden' : '') + '">' + fmt0(cell.Order) + '</td>';
        cellsHtml += '<td>' + fmt0(cell.HOTO) + '</td>';
      });
      var cityTot = last.cities[city].resolved.state;
      cellsHtml += '<td>' + fmt0(cityTot.BQL) + '</td><td>' + fmt0(cityTot.Order) + '</td><td>' + fmt0(cityTot.HOTO) + '</td>';
      tr.innerHTML = cellsHtml;
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        ['BQL', 'Order'].forEach(function (k) {
          var td = tr.querySelector('td[data-city="' + city + '"][data-sc="' + sc + '"][data-k="' + k + '"]');
          makeEditable(td, function () { return last.cross[city][sc][k]; }, false,
            function (v) { var key = city + '|' + sc; (state.overrides.cell[key] = state.overrides.cell[key] || {})[k] = v; },
            function () { var key = city + '|' + sc; if (state.overrides.cell[key]) delete state.overrides.cell[key][k]; });
        });
      });
      tbody.appendChild(tr);
    });
  }

  // ---------------- Rendering: Initiatives ----------------
  function renderInitiatives() {
    var list = document.getElementById('initiative-list');
    list.innerHTML = '';
    if (state.initiatives.length === 0) {
      list.innerHTML = '<p style="color:var(--text-mute);font-size:13px;">No initiatives added for this planning month yet.</p>';
      return;
    }
    state.initiatives.forEach(function (it, idx) {
      var scopeLabel = it.scope === 'all' ? 'All cities & sub-channels'
        : it.scope === 'city' ? ('City: ' + it.scopeCity)
          : ('Sub-channel: ' + it.scopeSubChannel);
      var impactLabel = it.impactType === 'percent' ? (it.impactValue > 0 ? '+' : '') + it.impactValue + '%'
        : (RATE_KEYS.indexOf(it.metric) !== -1 ? ((it.impactValue > 0 ? '+' : '') + it.impactValue + 'pp') : ((it.impactValue > 0 ? '+' : '') + it.impactValue));
      var div = document.createElement('div');
      div.className = 'initiative-item';
      div.innerHTML = '<div><div class="name">' + it.name + '</div><div class="meta">' + scopeLabel + ' \u00b7 ' + METRIC_LABELS[it.metric] + ' \u00b7 ' + (it.description || '') + '</div></div>' +
        '<div class="impact">' + impactLabel + '</div>' +
        '<button class="btn small danger" data-idx="' + idx + '">Remove</button>';
      div.querySelector('button').addEventListener('click', function () {
        state.initiatives.splice(idx, 1);
        computeAndRender();
      });
      list.appendChild(div);
    });
  }

  // ---------------- Rendering: Historical (verification) ----------------
  var histMode = 'city';
  var ALL_HIST_SUBCHANNELS = MOPCore.SUB_CHANNELS.concat(['BTL']);
  var histSubChannelSelection = MOPCore.SUB_CHANNELS.slice(); // BTL starts off; it's an opt-in extra, not part of any official total

  function histSource(key) {
    return key === 'BTL' ? { proj: last.btlHistProj } : last.subChannels[key];
  }

  function isFullDefaultSelection(sel) {
    if (sel.indexOf('BTL') !== -1) return false;
    if (sel.length !== MOPCore.SUB_CHANNELS.length) return false;
    return MOPCore.SUB_CHANNELS.every(function (c) { return sel.indexOf(c) !== -1; });
  }

  // Recomputes one city's trend using only the selected sub-channels
  // (rather than the city's full, all-channel total) — purely for this
  // tab; never touches the official projection used everywhere else.
  function computeCityHistProj(city, selection) {
    var rows = [];
    var nonBtl = selection.filter(function (c) { return c !== 'BTL'; });
    if (nonBtl.length > 0) {
      rows = rows.concat(MOPCore.filterRows(getUniverseRows(), { cities: [city], subChannels: nonBtl }));
    }
    if (selection.indexOf('BTL') !== -1) {
      rows = rows.concat(MOPCore.filterRows(state.rows, { cities: [city], subChannels: [MOPCore.BTL_CHANNEL] }));
    }
    return MOPCore.projectFunnelForRows(rows, state.settings, state.asOf, state.planningMonth);
  }

  function renderHistorical() {
    document.getElementById('hist-subchannel-picker').style.display = 'flex';

    var keys = histMode === 'city' ? CITY_NAMES : histSubChannelSelection;
    var label = histMode === 'city' ? 'City' : 'Sub-channel';
    var tbodyVol = document.getElementById('hist-vol-tbody');
    var tbodyRate = document.getElementById('hist-rate-tbody');

    if (histSubChannelSelection.length === 0) {
      document.getElementById('hist-vol-thead').innerHTML = '';
      document.getElementById('hist-rate-thead').innerHTML = '';
      tbodyVol.innerHTML = '<tr><td style="color:var(--text-mute);">Select at least one sub-channel above to see its history.</td></tr>';
      tbodyRate.innerHTML = '';
      return;
    }

    var source;
    if (histMode === 'city') {
      var useDefault = isFullDefaultSelection(histSubChannelSelection);
      var cityCache = {};
      source = function (k) {
        if (useDefault) return last.cities[k];
        if (!cityCache[k]) cityCache[k] = { proj: computeCityHistProj(k, histSubChannelSelection) };
        return cityCache[k];
      };
    } else {
      source = histSource;
    }
    var months = source(keys[0]).proj.months.map(function (m) { return m.monthKey; });
    var filterNote = document.getElementById('hist-filter-note');
    if (histMode === 'city' && !isFullDefaultSelection(histSubChannelSelection)) {
      filterNote.textContent = 'Showing city totals for only: ' + histSubChannelSelection.join(', ');
      filterNote.style.display = 'block';
    } else {
      filterNote.style.display = 'none';
    }

    renderHistoricalTable('hist-vol-thead', 'hist-vol-tbody', months, label, keys, source,
      [{ k: 'bql', label: 'BQL', pct: false }, { k: 'ms', label: 'MS', pct: false }, { k: 'md', label: 'MD', pct: false }, { k: 'order', label: 'Order', pct: false }, { k: 'hoto', label: 'HOTO', pct: false }]);

    renderHistoricalTable('hist-rate-thead', 'hist-rate-tbody', months, label, keys, source,
      [{ k: 'r1', label: 'BQL\u2192MS%', pct: true }, { k: 'r2', label: 'MS\u2192MD%', pct: true }, { k: 'r3', label: 'MD\u2192Ord%', pct: true }, { k: 'r4', label: 'Ord\u2192HOTO%', pct: true }]);
  }

  function renderHistoricalTable(theadId, tbodyId, months, label, keys, source, metricCols) {
    var thead = document.getElementById(theadId);
    var tbody = document.getElementById(tbodyId);

    thead.innerHTML = '<tr><th></th>' + months.map(function (m) {
      var isCampaign = state.settings.campaignMonths.indexOf(m) !== -1;
      return '<th class="month-sep" colspan="' + metricCols.length + '">' + m + (isCampaign ? ' (campaign)' : '') + '</th>';
    }).join('') + '</tr>' +
      '<tr><th>' + label + '</th>' +
      months.map(function () {
        return metricCols.map(function (c, idx) { return '<th' + (idx === 0 ? ' class="month-sep"' : '') + '>' + c.label + '</th>'; }).join('');
      }).join('') +
      '</tr>';

    tbody.innerHTML = '';

    // India (Total) — sum of the raw volumes across every key currently
    // shown (BTL excluded even if its row is visible, so this always
    // matches the official pan-India total used everywhere else),
    // with rates re-derived from the summed volumes rather than
    // averaged, so they stay mathematically correct.
    var sumKeys = keys.filter(function (k) { return k !== 'BTL'; });
    var agg = { bql: [], ms: [], md: [], order: [], hoto: [] };
    months.forEach(function (m, idx) {
      var t = { bql: 0, ms: 0, md: 0, order: 0, hoto: 0 };
      sumKeys.forEach(function (key) {
        var series = source(key).proj.series;
        t.bql += series.bql[idx]; t.ms += series.ms[idx]; t.md += series.md[idx];
        t.order += series.order[idx]; t.hoto += series.hoto[idx];
      });
      agg.bql.push(t.bql); agg.ms.push(t.ms); agg.md.push(t.md); agg.order.push(t.order); agg.hoto.push(t.hoto);
    });
    var aggSeries = {
      bql: agg.bql, ms: agg.ms, md: agg.md, order: agg.order, hoto: agg.hoto,
      r1: agg.bql.map(function (_, i) { return MOPCore.safeRate(agg.ms[i], agg.bql[i]); }),
      r2: agg.bql.map(function (_, i) { return MOPCore.safeRate(agg.md[i], agg.ms[i]); }),
      r3: agg.bql.map(function (_, i) { return MOPCore.safeRate(agg.order[i], agg.md[i]); }),
      r4: agg.bql.map(function (_, i) { return MOPCore.safeRate(agg.hoto[i], agg.order[i]); })
    };
    var indiaRow = document.createElement('tr');
    indiaRow.className = 'total-row';
    var indiaHtml = '<td>India (Total)</td>';
    months.forEach(function (m, idx) {
      metricCols.forEach(function (c, ci) {
        var v = aggSeries[c.k][idx];
        indiaHtml += '<td' + (ci === 0 ? ' class="month-sep"' : '') + '>' + (c.pct ? fmtPct(v) : fmt0(v)) + '</td>';
      });
    });
    indiaRow.innerHTML = indiaHtml;
    tbody.appendChild(indiaRow);

    keys.forEach(function (key) {
      var series = source(key).proj.series;
      var tr = document.createElement('tr');
      var isBtl = key === 'BTL';
      if (isBtl) tr.className = 'btl-row';
      var html = '<td>' + key + (isBtl ? ' <span style="font-size:10px;">(excluded from projection)</span>' : '') + '</td>';
      months.forEach(function (m, idx) {
        metricCols.forEach(function (c, ci) {
          var v = series[c.k][idx];
          html += '<td' + (ci === 0 ? ' class="month-sep"' : '') + '>' + (c.pct ? fmtPct(v) : fmt0(v)) + '</td>';
        });
      });
      tr.innerHTML = html;
      tbody.appendChild(tr);
    });
  }

  function initHistSubChannelPicker() {
    var wrap = document.getElementById('hist-subchannel-checks');
    wrap.innerHTML = '';
    ALL_HIST_SUBCHANNELS.forEach(function (sc) {
      var id = 'hist-sc-' + sc.replace(/[^a-zA-Z0-9]/g, '');
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12.5px;padding:5px 10px;border:1.5px solid var(--border);border-radius:999px;background:#fbfcfe;cursor:pointer;';
      var isChecked = histSubChannelSelection.indexOf(sc) !== -1;
      label.innerHTML = '<input type="checkbox" id="' + id + '" ' + (isChecked ? 'checked' : '') + ' style="margin:0;" /> ' + sc + (sc === 'BTL' ? ' (add reference)' : '');
      label.querySelector('input').addEventListener('change', function (e) {
        var idx = histSubChannelSelection.indexOf(sc);
        if (e.target.checked && idx === -1) histSubChannelSelection.push(sc);
        if (!e.target.checked && idx !== -1) histSubChannelSelection.splice(idx, 1);
        renderHistorical();
      });
      wrap.appendChild(label);
    });
  }

  // ---------------- Controls wiring ----------------
  function initControlsFromState() {
    document.getElementById('planning-month').value = state.planningMonth;
    document.getElementById('asof-date').value = asOfToMonthInput(state.asOf);
    document.getElementById('trailing-n').value = state.settings.trailingMonths;
    document.getElementById('min-days-current').value = state.settings.minDaysForCurrentMonth;
    document.getElementById('hoto-policy-rate').value = (state.settings.orderHotoPolicyRate * 100).toFixed(1);
    setSegmented('bql-field', state.settings.bqlField);
    setSegmented('ms-field', state.settings.msField);
    setSegmented('md-field', state.settings.mdField);
    setSegmented('hoto-mode', state.settings.orderHotoMode);
    document.getElementById('gh-token').value = state.gitHubToken;
    document.getElementById('gh-owner').value = state.gitHubOwner;
    document.getElementById('gh-repo').value = state.gitHubRepo;
    renderCampaignEditor();
  }

  function setSegmented(groupId, activeVal) {
    document.querySelectorAll('#' + groupId + ' button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.val === activeVal);
    });
  }

  function wireSegmented(groupId, settingKey) {
    document.querySelectorAll('#' + groupId + ' button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.settings[settingKey] = b.dataset.val;
        setSegmented(groupId, b.dataset.val);
        computeAndRender();
      });
    });
  }

  function renderCampaignEditor() {
    var wrap = document.getElementById('campaign-months');
    wrap.innerHTML = '';
    var months = [];
    var mk = MOPCore.addMonths(state.planningMonth, -8);
    for (var i = 0; i < 10; i++) { months.push(mk); mk = MOPCore.addMonths(mk, 1); }
    months.forEach(function (m) {
      var id = 'camp-' + m;
      var checked = state.settings.campaignMonths.indexOf(m) !== -1;
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12.5px;';
      label.innerHTML = '<input type="checkbox" id="' + id + '" ' + (checked ? 'checked' : '') + '/> ' + m;
      label.querySelector('input').addEventListener('change', function (e) {
        var idx = state.settings.campaignMonths.indexOf(m);
        if (e.target.checked && idx === -1) state.settings.campaignMonths.push(m);
        if (!e.target.checked && idx !== -1) state.settings.campaignMonths.splice(idx, 1);
        computeAndRender();
      });
      wrap.appendChild(label);
    });
  }

  function initEventListeners() {
    document.getElementById('planning-month').addEventListener('change', function (e) {
      state.planningMonth = e.target.value; renderCampaignEditor(); computeAndRender();
    });
    document.getElementById('asof-date').addEventListener('change', function (e) {
      var parts = e.target.value.split('-');
      state.asOf = { year: +parts[0], month: +parts[1], day: +parts[2] };
      computeAndRender();
    });
    document.getElementById('trailing-n').addEventListener('change', function (e) {
      state.settings.trailingMonths = Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 3));
      computeAndRender();
    });
    document.getElementById('min-days-current').addEventListener('change', function (e) {
      state.settings.minDaysForCurrentMonth = Math.max(1, Math.min(28, parseInt(e.target.value, 10) || 5));
      computeAndRender();
    });
    document.getElementById('hoto-policy-rate').addEventListener('change', function (e) {
      state.settings.orderHotoPolicyRate = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) / 100;
      computeAndRender();
    });
    wireSegmented('bql-field', 'bqlField');
    wireSegmented('ms-field', 'msField');
    wireSegmented('md-field', 'mdField');
    wireSegmented('hoto-mode', 'orderHotoMode');
    document.querySelectorAll('#hist-mode button').forEach(function (b) {
      b.addEventListener('click', function () {
        histMode = b.dataset.val;
        setSegmented('hist-mode', histMode);
        renderHistorical();
      });
    });
    initHistSubChannelPicker();

    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        document.getElementById('tab-' + b.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('add-initiative').addEventListener('click', function () {
      var form = document.getElementById('initiative-form');
      var scope = form.querySelector('[name=scope]').value;
      var it = {
        name: form.querySelector('[name=name]').value || 'Untitled initiative',
        description: form.querySelector('[name=description]').value,
        scope: scope,
        scopeCity: form.querySelector('[name=scopeCity]').value,
        scopeSubChannel: form.querySelector('[name=scopeSubChannel]').value,
        metric: form.querySelector('[name=metric]').value,
        impactType: form.querySelector('[name=impactType]').value,
        impactValue: parseFloat(form.querySelector('[name=impactValue]').value) || 0
      };
      state.initiatives.push(it);
      form.reset();
      computeAndRender();
    });

    document.getElementById('initiative-scope').addEventListener('change', function (e) {
      document.getElementById('scope-city-wrap').style.display = e.target.value === 'city' ? 'block' : 'none';
      document.getElementById('scope-subchannel-wrap').style.display = e.target.value === 'subChannel' ? 'block' : 'none';
    });

    document.getElementById('export-json').addEventListener('click', exportSnapshot);
    document.getElementById('export-excel').addEventListener('click', exportExcelFile);
    document.getElementById('save-version').addEventListener('click', saveVersionToGitHub);
    document.getElementById('gh-save-settings').addEventListener('click', function () {
      state.gitHubToken = document.getElementById('gh-token').value.trim();
      state.gitHubOwner = document.getElementById('gh-owner').value.trim();
      state.gitHubRepo = document.getElementById('gh-repo').value.trim();
      localStorage.setItem('mop_gh_token', state.gitHubToken);
      localStorage.setItem('mop_gh_owner', state.gitHubOwner);
      localStorage.setItem('mop_gh_repo', state.gitHubRepo);
      toast('Saved to this browser.');
    });
  }

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthKeyLabel(mk) {
    var p = MOPCore.parseMonthKey(mk);
    return MONTH_NAMES[p.month - 1] + " '" + String(p.year).slice(2);
  }

  // ---------------- Excel styling ----------------
  var XLTHEME = { blue: '149DE1', blueDark: '0F7FB8', light: 'EAF6FD', border: 'C7D3E0', muted: '8A94A6' };
  var XL_BORDER = { style: 'thin', color: { rgb: XLTHEME.border } };
  var XL_ALL_BORDERS = { top: XL_BORDER, bottom: XL_BORDER, left: XL_BORDER, right: XL_BORDER };
  var XL_STYLES = {
    title: { font: { bold: true, sz: 13, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: XLTHEME.blueDark } }, alignment: { vertical: 'center' } },
    subtitle: { font: { italic: true, sz: 9, color: { rgb: XLTHEME.muted } } },
    section: { font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: XLTHEME.blue } }, border: XL_ALL_BORDERS, alignment: { vertical: 'center' } },
    header: { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: XLTHEME.blue } }, border: XL_ALL_BORDERS, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    data: { border: XL_ALL_BORDERS, font: { sz: 10 } },
    total: { border: XL_ALL_BORDERS, font: { bold: true, sz: 10 }, fill: { fgColor: { rgb: XLTHEME.light } } },
    muted: { border: XL_ALL_BORDERS, font: { italic: true, sz: 9, color: { rgb: XLTHEME.muted } } },
    plain: null
  };

  function makeSheetBuilder() {
    var rows = [], meta = [];
    return {
      push: function (row, type, pctCols, numCols) { rows.push(row); meta.push({ type: type || 'data', pctCols: pctCols || [], numCols: numCols || [] }); return rows.length - 1; },
      rows: rows,
      meta: meta
    };
  }

  function buildStyledSheet(b, colWidths, merges) {
    var ws = XLSX.utils.aoa_to_sheet(b.rows);
    var range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    if (range) {
      b.meta.forEach(function (m, r) {
        var style = XL_STYLES[m.type];
        for (var c = range.s.c; c <= range.e.c; c++) {
          var addr = XLSX.utils.encode_cell({ r: r, c: c });
          if (style) {
            if (!ws[addr]) ws[addr] = { t: 's', v: '' };
            ws[addr].s = style;
          }
          if (ws[addr] && m.pctCols.indexOf(c) !== -1) ws[addr].z = '0.0%';
          if (ws[addr] && m.numCols.indexOf(c) !== -1) ws[addr].z = '#,##0';
        }
      });
    }
    if (colWidths) ws['!cols'] = colWidths.map(function (w) { return { wch: w }; });
    if (merges) ws['!merges'] = merges;
    return ws;
  }

  function exportExcelFile() {
    if (!last) { toast('Data not loaded yet.', true); return; }
    if (typeof XLSX === 'undefined') { toast('Excel library failed to load (check network/ad-blocker), then refresh and retry.', true); return; }
    var s = state.settings;
    var pm = state.planningMonth;
    var pmp = MOPCore.parseMonthKey(pm);
    var monthName = MONTH_NAMES[pmp.month - 1];
    var pan = last.panIndia.state;
    var wb = XLSX.utils.book_new();

    // ---- Summary ----
    var trailingLabels = last.panProj.months.map(function (m) { return monthKeyLabel(m.monthKey); });
    var sb = makeSheetBuilder();
    sb.push(['SolarSquare Energy \u2013 ' + monthName + ' ' + pmp.year + ' MOP Summary', '', '', '', '', ''], 'title');
    sb.push(['Projection basis: trailing ' + s.trailingMonths + ' complete months (' + trailingLabels.join(', ') + ') \u00b7 fields: BQL=' + s.bqlField + ', MS=' + s.msField + ', MD=' + s.mdField + ' \u00b7 Order\u2192HOTO: ' + (s.orderHotoMode === 'policy' ? 'policy ' + (s.orderHotoPolicyRate * 100).toFixed(1) + '%' : 'trend') + ' \u00b7 data as of ' + asOfToMonthInput(state.asOf)], 'subtitle');
    sb.push([], 'plain');
    sb.push(['Sub-Channel Summary (excl. BTL)', '', '', '', '', ''], 'section');
    sb.push(['Sub-Channel', 'BQL', 'MS', 'MD', 'Order', 'HOTO'], 'header');
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var st = last.subChannels[sc].resolved.state;
      sb.push([sc, round1(st.BQL), round1(st.MS), round1(st.MD), round1(st.Order), round1(st.HOTO)], 'data', [], [1, 2, 3, 4, 5]);
    });
    sb.push(['GRAND TOTAL', round1(pan.BQL), round1(pan.MS), round1(pan.MD), round1(pan.Order), round1(pan.HOTO)], 'total', [], [1, 2, 3, 4, 5]);
    sb.push([], 'plain');
    sb.push(['Overall Conversion Rates (Pan India excl. BTL)', '', '', '', ''], 'section');
    var rateHeader = ['Metric', monthName + " '" + String(pmp.year).slice(2) + ' Proj'].concat(trailingLabels.slice().reverse().map(function (l) { return l + ' Actual'; }));
    sb.push(rateHeader, 'header');
    ['r1', 'r2', 'r3', 'r4'].forEach(function (rk) {
      var label = { r1: 'BQL\u2192MS %', r2: 'MS\u2192MD %', r3: 'MD\u2192Order %', r4: 'Order\u2192HOTO %' }[rk];
      var row = [label, round4(pan[rk])];
      var series = last.panProj.series[rk].slice().reverse();
      series.forEach(function (v) { row.push(round4(v)); });
      var pctCols = row.map(function (_, i) { return i; }).slice(1);
      sb.push(row, 'data', pctCols, []);
    });
    sb.push([], 'plain');
    sb.push(['Initiatives applied this month', '', '', '', '', ''], 'section');
    if (state.initiatives.length === 0) { sb.push(['(none)'], 'data'); }
    state.initiatives.forEach(function (it) {
      var scopeLabel = it.scope === 'all' ? 'All' : it.scope === 'city' ? ('City: ' + it.scopeCity) : ('Sub-channel: ' + it.scopeSubChannel);
      sb.push([it.name, scopeLabel, METRIC_LABELS[it.metric], it.impactType, it.impactValue, it.description || ''], 'data');
    });
    var wsSummary = buildStyledSheet(sb, [26, 16, 16, 16, 16, 22], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // ---- Sub-Channel Funnel ----
    var scb = makeSheetBuilder();
    scb.push([monthName + ' ' + pmp.year + ' MOP  |  Sub-Channel Funnel (excl. BTL)', '', '', '', '', '', '', '', '', '', ''], 'title');
    scb.push(['Sub-Channel', 'BQL', 'MS', 'MD', 'Order', 'HOTO', 'BQL\u2192MS %', 'MS\u2192MD %', 'MD\u2192Ord %', 'Ord\u2192HOTO %', 'Overall BQL\u2192HOTO %'], 'header');
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var st = last.subChannels[sc].resolved.state;
      scb.push([sc, round1(st.BQL), round1(st.MS), round1(st.MD), round1(st.Order), round1(st.HOTO), round4(st.r1), round4(st.r2), round4(st.r3), round4(st.r4), round4(MOPCore.safeRate(st.HOTO, st.BQL))], 'data', [6, 7, 8, 9, 10], [1, 2, 3, 4, 5]);
    });
    scb.push(['TOTAL (excl. BTL)', round1(pan.BQL), round1(pan.MS), round1(pan.MD), round1(pan.Order), round1(pan.HOTO), round4(pan.r1), round4(pan.r2), round4(pan.r3), round4(pan.r4), round4(MOPCore.safeRate(pan.HOTO, pan.BQL))], 'total', [6, 7, 8, 9, 10], [1, 2, 3, 4, 5]);
    var b = last.btl.totals;
    scb.push(['BTL (excluded from projection, reference only)', round1(MOPCore.pick(b, s.bqlField)), round1(MOPCore.pick(b, s.msField)), round1(MOPCore.pick(b, s.mdField)), round1(b.Order), round1(b.HOTO), '', '', '', '', ''], 'muted', [], [1, 2, 3, 4, 5]);
    var wsSc = buildStyledSheet(scb, [30, 11, 11, 11, 11, 11, 11, 11, 11, 11, 15], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }]);
    XLSX.utils.book_append_sheet(wb, wsSc, 'Sub-Channel Funnel');

    // ---- City Funnel ----
    var cb = makeSheetBuilder();
    cb.push([monthName + ' ' + pmp.year + ' MOP  |  City-Level Funnel (excl. BTL)', '', '', '', '', '', '', '', '', '', '', ''], 'title');
    cb.push(['Cluster', 'City', 'BQL', 'MS', 'MD', 'Order', 'HOTO', 'BQL\u2192MS %', 'MS\u2192MD %', 'MD\u2192Ord %', 'Ord\u2192HOTO %', 'BQL\u2192HOTO %'], 'header');
    var cityTotals = { BQL: 0, MS: 0, MD: 0, Order: 0, HOTO: 0 };
    MOPCore.CITIES.forEach(function (c) {
      var st = last.cities[c.name].resolved.state;
      ['BQL', 'MS', 'MD', 'Order', 'HOTO'].forEach(function (k) { cityTotals[k] += st[k]; });
      cb.push([c.cluster, c.name, round1(st.BQL), round1(st.MS), round1(st.MD), round1(st.Order), round1(st.HOTO), round4(st.r1), round4(st.r2), round4(st.r3), round4(st.r4), round4(MOPCore.safeRate(st.HOTO, st.BQL))], 'data', [7, 8, 9, 10, 11], [2, 3, 4, 5, 6]);
    });
    cb.push(['', 'PAN INDIA TOTAL', round1(cityTotals.BQL), round1(cityTotals.MS), round1(cityTotals.MD), round1(cityTotals.Order), round1(cityTotals.HOTO),
      round4(MOPCore.safeRate(cityTotals.MS, cityTotals.BQL)), round4(MOPCore.safeRate(cityTotals.MD, cityTotals.MS)), round4(MOPCore.safeRate(cityTotals.Order, cityTotals.MD)), round4(MOPCore.safeRate(cityTotals.HOTO, cityTotals.Order)), round4(MOPCore.safeRate(cityTotals.HOTO, cityTotals.BQL))],
      'total', [7, 8, 9, 10, 11], [2, 3, 4, 5, 6]);
    var wsCity = buildStyledSheet(cb, [12, 16, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }]);
    XLSX.utils.book_append_sheet(wb, wsCity, 'City Funnel');

    // ---- City x Sub-Channel ----
    var xb = makeSheetBuilder();
    var totalCols = 2 + MOPCore.SUB_CHANNELS.length * 3 + 3;
    xb.push([monthName + ' ' + pmp.year + ' MOP | City \u00d7 Sub-Channel Targets (excl. BTL)'].concat(new Array(totalCols - 1).fill('')), 'title');
    var crossHeader1 = ['', ''];
    var crossHeader2 = ['Cluster', 'City'];
    MOPCore.SUB_CHANNELS.forEach(function (sc) { crossHeader1.push(sc, '', ''); crossHeader2.push('BQL', 'Order', 'HOTO'); });
    crossHeader1.push('CITY TOTAL', '', '');
    crossHeader2.push('BQL', 'Order', 'HOTO');
    xb.push(crossHeader1, 'section');
    xb.push(crossHeader2, 'header');
    var crossNumCols = [];
    for (var ci = 2; ci < totalCols; ci++) crossNumCols.push(ci);
    var crossTotals = { BQL: 0, Order: 0, HOTO: 0 };
    MOPCore.CITIES.forEach(function (c) {
      var row = [c.cluster, c.name];
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        var cell = last.cross[c.name][sc];
        row.push(round1(cell.BQL), round1(cell.Order), round1(cell.HOTO));
      });
      var cityTot = last.cities[c.name].resolved.state;
      row.push(round1(cityTot.BQL), round1(cityTot.Order), round1(cityTot.HOTO));
      crossTotals.BQL += cityTot.BQL; crossTotals.Order += cityTot.Order; crossTotals.HOTO += cityTot.HOTO;
      xb.push(row, 'data', [], crossNumCols);
    });
    var totalRow = ['', 'PAN INDIA TOTAL'];
    MOPCore.SUB_CHANNELS.forEach(function () { totalRow.push('', '', ''); });
    totalRow.push(round1(crossTotals.BQL), round1(crossTotals.Order), round1(crossTotals.HOTO));
    xb.push(totalRow, 'total', [], crossNumCols);
    var crossWidths = [12, 14].concat(new Array(MOPCore.SUB_CHANNELS.length * 3 + 3).fill(9));
    var crossMerges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];
    var mc = 2;
    MOPCore.SUB_CHANNELS.forEach(function () { crossMerges.push({ s: { r: 1, c: mc }, e: { r: 1, c: mc + 2 } }); mc += 3; });
    crossMerges.push({ s: { r: 1, c: mc }, e: { r: 1, c: mc + 2 } });
    var wsCross = buildStyledSheet(xb, crossWidths, crossMerges);
    XLSX.utils.book_append_sheet(wb, wsCross, 'CityxSub Channel');

    XLSX.writeFile(wb, monthName + '_MOP_Referral.xlsx', { cellStyles: true });
    toast('Downloaded ' + monthName + '_MOP_Referral.xlsx');
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  // ---------------- Snapshot / GitHub save ----------------
  function buildSnapshot() {
    return {
      savedAt: new Date().toISOString(),
      planningMonth: state.planningMonth,
      asOf: state.asOf,
      settings: state.settings,
      overrides: state.overrides,
      initiatives: state.initiatives,
      result: last ? {
        panIndia: last.panIndia.state,
        cities: Object.fromEntries(Object.entries(last.cities).map(function (e) { return [e[0], e[1].resolved.state]; })),
        subChannels: Object.fromEntries(Object.entries(last.subChannels).map(function (e) { return [e[0], e[1].resolved.state]; }))
      } : null
    };
  }

  function exportSnapshot() {
    var snap = buildSnapshot();
    var blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'mop_' + state.planningMonth + '_' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function saveVersionToGitHub() {
    if (!state.gitHubToken) { toast('Add a GitHub token in Settings first.', true); return; }
    var snap = buildSnapshot();
    var path = 'history/' + state.planningMonth + '/v_' + Date.now() + '.json';
    var content = JSON.stringify(snap, null, 2);
    var base = 'https://api.github.com/repos/' + state.gitHubOwner + '/' + state.gitHubRepo;
    var headers = {
      'Authorization': 'Bearer ' + state.gitHubToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
    toast('Saving\u2026');
    fetch(base + '/contents/' + path, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify({ message: 'MOP snapshot ' + state.planningMonth, content: btoa(unescape(encodeURIComponent(content))) })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ': ' + t); });
      return r.json();
    }).then(function () {
      toast('Version saved to ' + path);
    }).catch(function (err) {
      toast('Save failed: ' + err.message, true);
    });
  }

  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(function () { t.className = 'toast'; }, 3500);
  }

  function initStickyBehavior() {
    var controlsBar = document.getElementById('controls-bar');
    if (!controlsBar) return;
    function updateHeightVar() {
      document.documentElement.style.setProperty('--controls-height', controlsBar.offsetHeight + 'px');
    }
    function onScroll() {
      var compact = window.scrollY > 24;
      controlsBar.classList.toggle('compact', compact);
      updateHeightVar();
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateHeightVar);
    updateHeightVar();
  }

  // ---------------- Boot ----------------
  document.addEventListener('DOMContentLoaded', function () {
    initEventListeners();
    initStickyBehavior();
    loadData();
  });
})();
