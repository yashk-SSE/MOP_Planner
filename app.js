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
    var pm = state.planningMonth, asOf = state.asOf;

    var panProj = MOPCore.projectFunnelForRows(universe, pm, s, asOf);
    var panBase = MOPCore.applyInitiativesToBase(panProj.base, initiativesFor('all'));
    var panResolved = MOPCore.resolveFunnel(panBase, state.overrides.panIndia);

    var cityShares = MOPCore.computeShares(universe, CITY_NAMES, 'city', pm, s.trailingMonths, asOf, s.bqlField);
    var subShares = MOPCore.computeShares(universe, MOPCore.SUB_CHANNELS, 'subChannel', pm, s.trailingMonths, asOf, s.bqlField);

    var cities = {};
    CITY_NAMES.forEach(function (city) {
      var cityRows = MOPCore.filterRows(universe, { cities: [city] });
      var proj = MOPCore.projectFunnelForRows(cityRows, pm, s, asOf, panResolved.state.r4);
      var base = MOPCore.applyInitiativesToBase(proj.base, initiativesFor('city', city));
      var shareBQL = panResolved.state.BQL * (cityShares[city] || 0);
      var withShare = MOPCore.resolveFunnel(base, { BQL: shareBQL }).state;
      var resolved = MOPCore.resolveFunnel(withShare, state.overrides.city[city] || {});
      cities[city] = { base: base, ownTrendBQL: proj.base.BQL, share: cityShares[city] || 0, resolved: resolved };
    });

    var subChannels = {};
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var scRows = MOPCore.filterRows(universe, { subChannels: [sc] });
      var proj = MOPCore.projectFunnelForRows(scRows, pm, s, asOf, panResolved.state.r4);
      var base = MOPCore.applyInitiativesToBase(proj.base, initiativesFor('subChannel', null, sc));
      var shareBQL = panResolved.state.BQL * (subShares[sc] || 0);
      var withShare = MOPCore.resolveFunnel(base, { BQL: shareBQL }).state;
      var resolved = MOPCore.resolveFunnel(withShare, state.overrides.subChannel[sc] || {});
      subChannels[sc] = { base: base, share: subShares[sc] || 0, resolved: resolved };
    });

    var btlRows = MOPCore.filterRows(state.rows, { cities: CITY_NAMES, subChannels: [MOPCore.BTL_CHANNEL] });
    var lastFullMonth = MOPCore.addMonths(pm, -1);
    var lp = MOPCore.parseMonthKey(lastFullMonth);
    var btlFig = MOPCore.getMonthFigure(btlRows, lp.year, lp.month, asOf);

    var cross = {};
    CITY_NAMES.forEach(function (city) {
      var cityRows = MOPCore.filterRows(universe, { cities: [city] });
      var withinShares = MOPCore.computeShares(cityRows, MOPCore.SUB_CHANNELS, 'subChannel', pm, s.trailingMonths, asOf, s.bqlField);
      var cityFinal = cities[city].resolved.state;
      var weights = {}, weightSum = 0;
      MOPCore.SUB_CHANNELS.forEach(function (sc) {
        var cellRows = MOPCore.filterRows(universe, { cities: [city], subChannels: [sc] });
        var months = MOPCore.buildTrailingSeries(cellRows, pm, s.trailingMonths, asOf);
        var ratios = months.map(function (mo) {
          var t = mo.figure.totals;
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
      cross: cross, btl: btlFig, cityShares: cityShares, subShares: subShares
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
    renderInitiatives();
  }

  // ---------------- Editable cell helper ----------------
  function makeEditable(el, getValue, isPercent, onCommit, onClear) {
    el.classList.add('cell-editable');
    el.addEventListener('click', function () {
      if (el.querySelector('input')) return;
      var raw = getValue();
      var display = isPercent ? (raw * 100).toFixed(2) : Math.round(raw);
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

  // ---------------- Rendering: Summary ----------------
  function renderSummary() {
    var r = last.panIndia.state, flags = last.panIndia.flags;
    var cardGrid = document.getElementById('summary-cards');
    cardGrid.innerHTML = '';
    VOL_KEYS.forEach(function (k) {
      var card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = '<div class="label">' + METRIC_LABELS[k] + '</div>' +
        '<div class="value ' + (flags[k] ? 'overridden' : '') + '">' + fmt0(r[k]) + '</div>' +
        '<div class="delta">' + (flags[k] === 'derived' ? 'rate back-solved from override' : (flags[k] ? 'manually overwritten' : 'projected')) + '</div>';
      var valEl = card.querySelector('.value');
      makeEditable(valEl, function () { return r[k]; }, false,
        function (v) { state.overrides.panIndia[k] = v; },
        function () { delete state.overrides.panIndia[k]; });
      cardGrid.appendChild(card);
    });

    var rateGrid = document.getElementById('summary-rates');
    rateGrid.innerHTML = '';
    RATE_KEYS.forEach(function (k) {
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
      valEl.textContent = fmtPct(r[k]);
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
        (m.isEstimated ? '<span class="tag est">run-rate est.</span>' : '') +
        '<span>BQL ' + fmt0(m.bql) + '</span>';
      strip.appendChild(chip);
    });
  }

  // ---------------- Rendering: Cities ----------------
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
        var st = c.resolved.state, fl = c.resolved.flags;
        VOL_KEYS.forEach(function (k) { totals[k] += st[k]; });
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td>' + city + '</td>' +
          VOL_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmt0(st[k]) + '</td>'; }).join('') +
          RATE_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmtPct(st[k]) + '</td>'; }).join('') +
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
      ' (should match \u2014 city BQL is share-derived from this same pan-India number, not independently trended)';
  }

  // ---------------- Rendering: Sub-channels ----------------
  function renderSubChannels() {
    var tbody = document.getElementById('subchannels-tbody');
    tbody.innerHTML = '';
    MOPCore.SUB_CHANNELS.forEach(function (sc) {
      var c = last.subChannels[sc];
      var st = c.resolved.state, fl = c.resolved.flags;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + sc + '</td>' +
        VOL_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmt0(st[k]) + '</td>'; }).join('') +
        RATE_KEYS.map(function (k) { return '<td data-k="' + k + '" class="' + (fl[k] ? 'cell-overridden' : '') + '">' + fmtPct(st[k]) + '</td>'; }).join('') +
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

  // ---------------- Controls wiring ----------------
  function initControlsFromState() {
    document.getElementById('planning-month').value = state.planningMonth;
    document.getElementById('asof-date').value = asOfToMonthInput(state.asOf);
    document.getElementById('trailing-n').value = state.settings.trailingMonths;
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
    document.getElementById('hoto-policy-rate').addEventListener('change', function (e) {
      state.settings.orderHotoPolicyRate = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) / 100;
      computeAndRender();
    });
    wireSegmented('bql-field', 'bqlField');
    wireSegmented('ms-field', 'msField');
    wireSegmented('md-field', 'mdField');
    wireSegmented('hoto-mode', 'orderHotoMode');

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

  // ---------------- Boot ----------------
  document.addEventListener('DOMContentLoaded', function () {
    initEventListeners();
    loadData();
  });
})();
