/* ledger-v4-app.js  --  THE LEDGER client runtime skeleton.
 *
 * Every view render function plugs into this. It owns: the DATA object (read
 * from a JSON script tag), the helpers, the pure renderVals(state) port of v4,
 * the render() loop that concatenates window.LEDGER_VIEWS.<key>(vm) into the
 * mount node, and the delegated event system that mutates state and re-renders.
 *
 * Gate 3: no em dash, no en dash, no curly quotes. Every non-ASCII glyph in a
 * reading string is written as a \uXXXX escape, so the source bytes are ASCII
 * and a grep for the dash/quote glyphs finds zero. The one v4 en dash in the
 * posted-range string is a plain hyphen here.
 *
 * One clock: no Date.now(), no new Date() for "now". dstr derives a fixed date
 * from SWEEP.clock only.
 *
 * Token names: the ported strings keep v4's --accent, --font-mono,
 * --color-surface-2 and --font-sans. ledger-v4.css aliases each to the site
 * token (--color-signal, --font-family-mono, --color-surface-raised,
 * --font-family-sans) on :root, so the mapping happens once in CSS instead of
 * in hundreds of inline strings, and the view HTML the other agents emit keeps
 * working unchanged.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // DATA: read the injected JSON once, freeze it, destructure.
  // -------------------------------------------------------------------------
  var DATA = readData();
  function readData() {
    var el = document.getElementById('ledger-data');
    var parsed = {};
    try { parsed = JSON.parse(el ? el.textContent : '{}'); } catch (e) { parsed = {}; }
    return Object.freeze(parsed);
  }

  // NUMBERS, NOT ROWS (2026-09-23). This file used to hold DATA.LIVE, every
  // live posting on the board, and filter and reduce that array into every
  // chart. At 31,310 rows the page carried 12.0 MB of JSON and stopped
  // rendering. Now the server sends only the aggregates for the current cut:
  // AGG for the live views, KAGG for the archive, and FACTS for the handful of
  // board-wide numbers no filter moves. A filter press fetches a new AGG.
  //
  // There is no row list and no export any more, and no endpoint behind this
  // page returns a posting.
  var SWEEP = DATA.SWEEP || {};
  var FACTS = DATA.FACTS || { liveN: 0, customLivePct: 0, atsOptions: [], titleIndex: [] };
  var AGG = (DATA.VIEW && DATA.VIEW.live) || emptyAgg();
  var KAGG = (DATA.VIEW && DATA.VIEW.kills) || emptyKagg();
  var INDUSTRY = DATA.INDUSTRY || [];
  var TEAM = DATA.TEAM || [];
  var SIGNALS = DATA.SIGNALS || [];
  var TIERS = DATA.TIERS || ['Senior', 'Staff', 'Lead', 'Director'];
  var RULES = DATA.RULES || [];
  var RULE_KEYS = DATA.RULE_KEYS || [];
  var PAY_LO = DATA.PAY_LO, PAY_HI = DATA.PAY_HI, LIFE_HI = DATA.LIFE_HI;

  function emptyBox(label) {
    return { label: label, n: 0, priced: 0, lo: null, p25: null, p50: null, p75: null, hi: null };
  }
  function emptyAgg() {
    return { cutN: 0, pricedN: 0, unpricedN: 0, ladder: [], place: [emptyBox('Remote'), emptyBox('In office')],
      density: [], fitLo: null, fitHi: null, midMed: null, fitMed: null, quadN: 0,
      bandCounts: [0, 0, 0, 0, 0], bandN: 0, bandMed: null, drag: [], issuers: [],
      ageCounts: [0, 0, 0, 0, 0, 0, 0, 0], in48: 0, in96: 0, past14: 0, geo: [], facets: {} };
  }
  function emptyKagg() {
    return { killCutN: 0, archiveTotal: 0, atsCols: [], heat: {}, life: [], churnCounts: [], firedMax: 0, customKills: 0 };
  }

  // The watched title groups, as the server reports them for the whole board.
  var TITLE_INDEX = FACTS.titleIndex || [];

  // Where a filter press goes for its numbers. The mount carries it so the path
  // is decided once, server side, rather than guessed from location.
  var SUMMARY_PATH = (document.getElementById('ledger-app') &&
    document.getElementById('ledger-app').dataset.summary) || '/jobs-data/summary';

  // -------------------------------------------------------------------------
  // Mount + state.
  // -------------------------------------------------------------------------
  var mount = document.getElementById('ledger-app');
  var watchSeq = 0;

  var state = {
    // Read from the root, never written here: BaseLayout's theme authority
    // owns data-theme (see antialgo:themechange below).
    theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    watches: [],
    where: 'anywhere', floor: 0, priced: 'any', age: 0, level: 'any',
    ats: 'any', friction: 'any', record: 'any',
    // risk is not in this list. The control is hidden until the field it reads
    // is defined; see the note on moreRows below.
    moreOpen: false,
    watchOpen: false, query: '',
    // The fetch state for the cut. `pending` is true while a filter press is in
    // flight, so the page can say it is reading rather than appear frozen, and
    // `failed` carries the last error so a dropped request is visible instead
    // of silently leaving the previous numbers on screen.
    pending: false, failed: '',
    named: !!(mount && mount.dataset.named === 'true'),
    sort: { key: 'kills', dir: 'desc' },
    read: {}
  };

  var currentVm = null; // the last view-model, so event handlers can read vm.tsv etc.

  // -------------------------------------------------------------------------
  // Helpers (copied from v4; the interactive closures are gone).
  // -------------------------------------------------------------------------
  // The applicant system's display name. The server sends the raw key it
  // stores ('ashby', 'usajobs'), because that is what a filter binds to; the
  // label is presentation and belongs here. Anything unknown is titlecased, so
  // a system that ships tonight appears by name rather than being collapsed.
  var ATS_LABELS = {
    ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever', workday: 'Workday',
    workable: 'Workable', rippling: 'Rippling', personio: 'Personio', usajobs: 'USAJOBS',
    amazon: 'Amazon', netflix: 'Netflix', yc: 'Y Combinator', recruitee: 'Recruitee',
    breezy: 'Breezy', teamtailor: 'Teamtailor', jobvite: 'Jobvite', bamboohr: 'BambooHR',
    icims: 'iCIMS', taleo: 'Taleo', successfactors: 'SuccessFactors', arbeitnow: 'Arbeitnow',
    hirehive: 'HireHive', eightfold: 'Eightfold'
  };
  function atsLabel(key) {
    var k = String(key == null ? '' : key).trim().toLowerCase();
    if (!k) return 'the company site';
    if (ATS_LABELS[k]) return ATS_LABELS[k];
    return k.replace(/[_-]+/g, ' ').replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
  }

  function payPct(v) { return Math.max(0, Math.min(100, ((v - PAY_LO) / (PAY_HI - PAY_LO)) * 100)); }

  function indexFor(title) {
    return TITLE_INDEX.filter(function (t) { return t.title.toLowerCase() === title.toLowerCase(); })[0];
  }
  // A fixed calendar date derived from the sweep clock (never host time).
  function dstr(daysAgo) {
    var base = Date.parse(SWEEP.clock + 'T00:00:00Z');
    return new Date(base - daysAgo * 86400000).toISOString().slice(0, 10);
  }
  // chip carries act + val instead of an onClick closure; visual logic is v4's.
  function chip(label, on, act, val, count) {
    return {
      label: label,
      count: (count === undefined || count === null) ? '' : String(count),
      onStr: on ? 'true' : 'false', act: act, val: String(val),
      border: on ? 'var(--color-foreground)' : 'var(--color-line-strong)',
      bg: on ? 'var(--color-foreground)' : 'transparent',
      ink: on ? 'var(--color-surface)' : 'var(--color-foreground)'
    };
  }

  // THE BOX PLOTS READ FIVE NUMBERS, NOT A LIST OF ROWS. The server sends
  // {n, priced, lo, p25, p50, p75, hi} per box, computed with the same
  // interpolation and rounding this file used to do in the browser.
  function payBox(box, hoverKey) {
    if (!box || !box.priced) {
      return { tier: box ? box.label : '', stat: ((box && box.n) || 0) + ' rows', hasBox: false, noBox: true,
        emptyNote: 'No priced rows here in this cut.' };
    }
    var text = box.label + ': median $' + box.p50 + 'k, middle half $' + box.p25 + 'k to $' + box.p75
      + 'k, range $' + box.lo + 'k to $' + box.hi + 'k, ' + box.priced + ' priced of ' + box.n
      + ', read ' + SWEEP.clock;
    return {
      tier: box.label, hasBox: true, noBox: false,
      stat: 'n ' + box.n + ' \u00b7 priced ' + box.priced + ' \u00b7 med $' + box.p50 + 'k',
      whiskL: payPct(box.lo), whiskW: payPct(box.hi) - payPct(box.lo),
      boxL: payPct(box.p25), boxW: Math.max(1.2, payPct(box.p75) - payPct(box.p25)),
      medL: payPct(box.p50), aria: text, unpriced: box.n - box.priced, readKey: hoverKey
    };
  }

  function lifeBox(box) {
    if (!box || !box.priced) {
      return { tier: box ? box.label : '', stat: '0 rows', hasBox: false, noBox: true,
        emptyNote: 'No kills on this rule in this cut.' };
    }
    var pct = function (v) { return Math.max(0, Math.min(100, (v / LIFE_HI) * 100)); };
    var text = box.label + ': median ' + box.p50 + ' days standing, middle half ' + box.p25 + ' to ' + box.p75
      + ', range ' + box.lo + ' to ' + box.hi + ', n ' + box.priced + ', archive read ' + SWEEP.clock;
    return { tier: box.label, stat: 'n ' + box.priced + ' \u00b7 med ' + box.p50 + 'd', hasBox: true, noBox: false,
      whiskL: pct(box.lo), whiskW: pct(box.hi) - pct(box.lo),
      boxL: pct(box.p25), boxW: Math.max(1.2, pct(box.p75) - pct(box.p25)), medL: pct(box.p50),
      aria: text, readKey: 'life' };
  }

  /** The count under one filter button, as the server computed it. */
  function facet(dim, val) {
    var row = AGG.facets && AGG.facets[dim];
    var n = row ? row[String(val)] : undefined;
    return n === undefined ? '' : n;
  }

  // -------------------------------------------------------------------------
  // renderVals(st): PURE. Reads state + module-scope DATA/helpers, returns a
  // plain view-model. No DOM, no clock, no mutation. Interactive closures are
  // replaced by data-act / data-read-key descriptors the views turn into DOM
  // attributes. This is v4's renderVals arithmetic, unchanged but for: the
  // token/dash purge, BOARD -> LIVE, null-age handling (contract 1.11), and the
  // synthetic v4 literals (12 industries, 384/374/10) read from DATA instead.
  // -------------------------------------------------------------------------
  function renderVals(st) {
    var named = st.named;
    var cutN = AGG.cutN;
    var liveN = FACTS.liveN;
    var pricedN = AGG.pricedN;
    var unpricedCut = AGG.unpricedN;
    var killCutN = KAGG.killCutN;

    var watched = st.watches.map(function (w) { return { w: w, idx: indexFor(w.title) }; });
    var noTitles = st.watches.length === 0;

    var titleCount = st.watches.length;
    var segParts = [];
    segParts.push(noTitles ? 'whole board, no title set' : titleCount + (titleCount === 1 ? ' title' : ' titles'));
    if (st.where !== 'anywhere') segParts.push(st.where);
    if (st.floor) segParts.push('floor $' + st.floor + 'k');
    if (st.priced === 'priced') segParts.push('range printed');
    if (st.priced === 'unpriced') segParts.push('no range printed');
    if (st.age) segParts.push('posted within ' + (st.age <= 4 ? st.age * 24 + 'h' : st.age + 'd'));
    if (st.level !== 'any') segParts.push(st.level);
    if (st.ats !== 'any') segParts.push(atsLabel(st.ats));
    if (st.friction !== 'any') segParts.push(st.friction === 'hard' ? 'account needed to apply' : 'no account to apply');
    if (st.record === 'clean') segParts.push('no kills on record');
    if (st.record === 'lowchurn') segParts.push('under 10 reposts');
    var cutLabel = 'cut to ' + segParts.join(' · ');

    var watchView = function (wch) {
      var idx = indexFor(wch.title);
      var variants = idx ? idx.variants : [];
      var on = variants.filter(function (v) { return wch.off.indexOf(v[0]) === -1; });
      var live = on.reduce(function (a, v) { return a + v[1]; }, 0);
      return {
        id: wch.id, title: wch.title, shelf: wch.shelf,
        liveNote: idx ? live + ' live · ' + on.length + ' of ' + variants.length + ' titles' : 'not read yet · joins tonight',
        coverInk: idx ? 'var(--color-muted)' : 'var(--accent)',
        hasVariants: variants.length > 0, noVariants: variants.length === 0,
        expanded: wch.expanded && variants.length > 0,
        expandLabel: wch.expanded ? 'Hide matched titles' : variants.length + ' matched titles',
        variants: variants.map(function (v) {
          var isOn = wch.off.indexOf(v[0]) === -1;
          return { s: v[0], n: v[1], onStr: isOn ? 'true' : 'false', mark: isOn ? 'on' : 'off',
            border: isOn ? 'var(--color-foreground)' : 'var(--color-line)',
            bg: isOn ? 'var(--color-hover)' : 'transparent',
            ink: isOn ? 'var(--color-foreground)' : 'var(--color-muted)' };
        }),
        moveLabel: wch.shelf === 'core' ? 'Move to stretch' : 'Move to core'
      };
    };
    var allViews = st.watches.map(watchView);

    var q = st.query.trim().toLowerCase();
    var results = q.length < 2 ? [] : TITLE_INDEX.filter(function (t) {
      return t.title.toLowerCase().indexOf(q) > -1 || t.variants.some(function (v) { return v[0].toLowerCase().indexOf(q) > -1; });
    }).map(function (t) {
      return { title: t.title, n: t.n,
        variantNote: 'reads as ' + t.variants.length + ' strings on the board, ' + (t.variants[0] ? t.variants[0][0] : 'none') + ' and ' + Math.max(0, t.variants.length - 1) + ' more' };
    });

    // ---- cross cut 1: pay ladder
    var ladder = (AGG.ladder || []).map(function (bx) { return payBox(bx, 'ladder'); });
    var ladderMeds = (AGG.ladder || []).map(function (bx) { return bx.priced ? bx.p50 : null; });
    var step = 'Not enough priced rows at two levels in this cut to read a step.';
    for (var li = 0; li < 3; li++) {
      if (ladderMeds[li] !== null && ladderMeds[li] !== undefined &&
          ladderMeds[li + 1] !== null && ladderMeds[li + 1] !== undefined) {
        var dstep = ladderMeds[li + 1] - ladderMeds[li];
        step = TIERS[li] + ' to ' + TIERS[li + 1] + ' is ' + (dstep >= 0 ? '+' : '') + '$' + dstep + 'k on posted midpoints, read ' + SWEEP.clock;
        break;
      }
    }

    // ---- cross cut 2: remote against onsite
    var placeSplit = (AGG.place || []).map(function (bx) { return payBox(bx, 'place'); });
    var rMed = AGG.place && AGG.place[0] && AGG.place[0].priced ? AGG.place[0].p50 : null;
    var oMed = AGG.place && AGG.place[1] && AGG.place[1].priced ? AGG.place[1].p50 : null;
    var placeRead = 'One side of this split has no priced rows in this cut, so no comparison is printed.';
    var placeCaveat = 'A missing side is a gap in what employers printed, not a zero.';
    if (rMed !== null && oMed !== null) {
      var pd = rMed - oMed;
      placeRead = 'remote median $' + rMed + 'k · in office median $' + oMed + 'k · ' + (pd === 0 ? 'no gap' : (pd > 0 ? 'remote sits $' + pd + 'k above' : 'remote sits $' + Math.abs(pd) + 'k below')) + ' · read ' + SWEEP.clock;
      placeCaveat = 'Only ' + AGG.place[1].priced + ' in-office rows print a range in this cut, so the in-office box moves fast. Read the count before the gap.';
    }

    // ---- cross cut 3: fit against pay
    //
    // THIS WAS A SCATTER OF POSTINGS AND IS NOW A DENSITY GRID. The old plot
    // sampled up to 500 individual rows and named a company and a title in each
    // point's reading. The server now sends a count per (pay bin, fit) cell,
    // which draws the same distribution and carries no posting. Cells with more
    // rows behind them are drawn larger.
    var midMed = AGG.midMed === null ? 200 : AGG.midMed;
    var fitMed = AGG.fitMed === null ? 70 : AGG.fitMed;
    var fitLo = AGG.fitLo === null ? 30 : AGG.fitLo;
    var fitHi = AGG.fitHi === null ? 100 : AGG.fitHi;
    var fitSpan = (fitHi - fitLo) || 1;
    var fitScaleY = function (f) { return Math.max(0, Math.min(100, ((f - fitLo) / fitSpan) * 92 + 4)); };
    var cells = AGG.density || [];
    var cellMax = cells.reduce(function (a, c) { return c.n > a ? c.n : a; }, 1);
    var scatter = cells.map(function (c) {
      var hi = c.fit >= fitMed;
      // Bin centre, as a percentage of the fixed pay axis.
      var x = ((c.x - 0.5) / 48) * 100;
      var pay = Math.round(PAY_LO + (x / 100) * (PAY_HI - PAY_LO));
      return {
        x: Math.max(0, Math.min(100, x)),
        y: fitScaleY(c.fit),
        r: 1.1 + 2.4 * Math.sqrt(c.n / cellMax),
        aria: c.n + (c.n === 1 ? ' row' : ' rows') + ' near $' + pay + 'k at fit ' + c.fit + ', read ' + SWEEP.clock,
        readKey: 'scatter',
        fill: hi ? 'var(--accent)' : 'var(--color-foreground)',
        stroke: hi ? 'var(--accent)' : 'var(--color-foreground)'
      };
    });
    var quadN = AGG.quadN;

    // ---- cross cut 4: negotiation band
    var bandDefs = [['under 15%', 0, 0.15], ['15 to 25%', 0.15, 0.25], ['25 to 35%', 0.25, 0.35], ['35 to 45%', 0.35, 0.45], ['45% and up', 0.45, 99]];
    var bandCounts = AGG.bandCounts || [0, 0, 0, 0, 0];
    var bandN = AGG.bandN;
    var bandMed = AGG.bandMed;
    var bandMax = Math.max.apply(null, bandCounts.concat([1]));
    var bandBuckets = bandDefs.map(function (dd, i) {
      var text = dd[0] + ' band on ' + bandCounts[i] + ' of ' + bandN + ' priced rows, read ' + SWEEP.clock;
      return { label: dd[0], count: bandCounts[i], h: Math.max(2, Math.round((bandCounts[i] / bandMax) * 140)),
        fill: i >= 3 ? 'var(--accent)' : 'var(--color-foreground)', stroke: i >= 3 ? 'var(--accent)' : 'var(--color-foreground)',
        aria: text, readKey: 'band' };
    });

    // ---- fit drag
    var dragNames = { title_scope: 'title and scope', remote_geo: 'where it is', comp: 'pay printed', freshness: 'freshness', apply_friction: 'apply friction' };
    var dragWeights = { title_scope: 30, remote_geo: 25, comp: 20, freshness: 15, apply_friction: 10 };
    var dragRows = (AGG.drag || []).map(function (dd) {
      var name = dragNames[dd.key] || dd.key;
      var weight = dragWeights[dd.key] || 0;
      var pct = Math.round((dd.avg / weight) * 100);
      var text = name + ': average ' + dd.avg + ' of ' + weight + ' available, sits at zero on ' + dd.zeros + ' of ' + cutN + ' rows, read ' + SWEEP.clock;
      return { name: name, weight: weight, avg: dd.avg, pct: pct, zeros: dd.zeros,
        fill: pct < 45 ? 'var(--accent)' : 'var(--color-foreground)',
        zeroNote: dd.zeros === 0 ? 'Never sits at zero in this cut.' : 'Sits at zero on ' + dd.zeros + ' of ' + cutN + ' rows.',
        zeroInk: dd.zeros > cutN * 0.3 ? 'var(--accent)' : 'var(--color-muted)',
        aria: text, readKey: 'drag' };
    });
    var worst = dragRows.slice().sort(function (a, b) { return b.zeros - a.zeros; })[0];
    var dragReading = worst && worst.zeros > 0
      ? 'In this cut the drag is ' + worst.name + '. It earns nothing on ' + worst.zeros + ' of ' + cutN + ' rows, which is what pulls the median score down. That is a property of the postings, not of your resume.'
      : 'In this cut no component sits at zero anywhere, which is rare. Scores here are moving on degree, not on absence.';

    // ---- issuer table. One row per COMPANY, an aggregate of that company's
    // postings; never a posting.
    var issuers = (AGG.issuers || []).slice();
    var sortKey = st.sort.key, dir = st.sort.dir === 'asc' ? 1 : -1;
    issuers.sort(function (a, b) {
      if (sortKey === 'co') return a.co.localeCompare(b.co) * dir;
      var av = a[sortKey === 'med' ? 'med' : sortKey === 'remote' ? 'remotePct' : sortKey];
      var bv = b[sortKey === 'med' ? 'med' : sortKey === 'remote' ? 'remotePct' : sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return a.co.localeCompare(b.co);
      return (av - bv) * dir;
    });
    var issuerRows = issuers.map(function (r) {
      return {
        name: named ? r.co : r.alias,
        nameFont: named ? 'var(--font-sans)' : 'var(--font-mono)',
        nameInk: named ? 'var(--color-foreground)' : 'var(--color-muted)',
        ats: atsLabel(r.ats), live: r.live,
        hasMed: r.med !== null, noMed: r.med === null,
        med: r.med !== null ? '$' + r.med + 'k' : '',
        remotePct: r.remotePct === null ? 0 : r.remotePct,
        remoteLabel: r.remotePct === null ? '0%' : r.remotePct + '%',
        kills: r.kills, reposts: r.reposts, maxFired: r.maxFired === 0 ? '0' : r.maxFired + 'x',
        killInk: r.kills >= 8 ? 'var(--accent)' : 'var(--color-foreground)',
        firedInk: r.maxFired >= 10 ? 'var(--accent)' : 'var(--color-foreground)'
      };
    });
    var colDefs = [['co', 'Issuer', 'left'], ['live', 'Live', 'right'], ['med', 'Median range', 'right'], ['remote', 'Remote share', 'right'], ['kills', 'Kills on record', 'right'], ['reposts', 'Reposts', 'right'], ['maxFired', 'Max fired', 'right']];
    var issuerCols = colDefs.map(function (c) {
      var active = sortKey === c[0];
      return { label: c[1], align: c[2], justify: c[2] === 'right' ? 'flex-end' : 'flex-start', col: c[0], key: c[0],
        ink: active ? 'var(--color-foreground)' : 'var(--color-muted)',
        glyph: active ? (st.sort.dir === 'asc' ? '↑' : '↓') : '',
        ariaSort: active ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' };
    });
    var colName = {};
    colDefs.forEach(function (c) { colName[c[0]] = c[1].toLowerCase(); });

    // ---- kill archive crossed
    var COMPANY_SITE = 'the company site';
    var atsCols = (KAGG.atsCols || []).map(atsLabel);
    if (!atsCols.length) atsCols = [COMPANY_SITE];
    var heatAt = function (ruleKey, atsKey) {
      var row = KAGG.heat && KAGG.heat[ruleKey];
      return (row && row[atsKey]) || 0;
    };
    var heatMax = 1;
    RULE_KEYS.forEach(function (rk) {
      (KAGG.atsCols || []).forEach(function (ak) {
        var n = heatAt(rk, ak);
        if (n > heatMax) heatMax = n;
      });
    });
    var heatRows = RULE_KEYS.map(function (ruleKey, ri) {
      var rule = RULES[ri] || ruleKey;
      return { rule: rule, cells: (KAGG.atsCols.length ? KAGG.atsCols : ['']).map(function (atsKey) {
        var n = heatAt(ruleKey, atsKey);
        var pct = Math.round((n / heatMax) * 100);
        var text = rule + ' on ' + atsLabel(atsKey) + ': ' + n + ' of ' + killCutN + ' kills in this cut, archive read ' + SWEEP.clock;
        return { n: n, bg: n === 0 ? 'var(--color-surface)' : 'color-mix(in srgb, var(--accent) ' + Math.max(8, pct) + '%, var(--color-surface))',
          ink: pct > 55 ? 'var(--accent-ink)' : 'var(--color-foreground)', aria: text, readKey: 'heat' };
      }) };
    });
    var customShare = killCutN ? Math.round((KAGG.customKills / killCutN) * 100) : 0;
    var customLive = FACTS.customLivePct;
    var heatReading = 'Company career pages are ' + customLive + '% of the rows on the board and ' + customShare + '% of the kills in this cut. Read those postings twice before you spend an evening on one.';

    var lifeRows = (KAGG.life || []).map(lifeBox);

    var churnDefs = [['1', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4-5', 4, 5], ['6-9', 6, 9], ['10-15', 10, 15], ['16-28', 16, 28]];
    var churnCounts = KAGG.churnCounts || [0, 0, 0, 0, 0, 0, 0];
    var churnMax = Math.max.apply(null, churnCounts.concat([1]));
    var firedMax = KAGG.firedMax;
    var churnBuckets = churnDefs.map(function (dd, i) {
      var text = 'fired ' + dd[0] + ' times: ' + churnCounts[i] + ' of ' + killCutN + ' kills in this cut, archive read ' + SWEEP.clock;
      return { label: dd[0], count: churnCounts[i], h: Math.max(2, Math.round((churnCounts[i] / churnMax) * 142)),
        fill: i >= 5 ? 'var(--accent)' : 'var(--color-foreground)', aria: text, readKey: 'churn' };
    });

    // ---- head start (arrival curve)
    var ageDefs = [['0-1d', 0, 1], ['2d', 2, 2], ['3-4d', 3, 4], ['5-7d', 5, 7], ['8-14d', 8, 14], ['15-30d', 15, 30], ['1-3mo', 31, 90], ['3mo+', 91, 9999]];
    var ageCounts = AGG.ageCounts || [0, 0, 0, 0, 0, 0, 0, 0];
    var ageMax = Math.max.apply(null, ageCounts.concat([1]));
    var ageBuckets = ageDefs.map(function (dd, i) {
      var zone = i === 0 ? 'inside 48 hours' : i === 1 ? '48 to 96 hours' : 'past 96 hours';
      var text = dd[0] + ' old: ' + ageCounts[i] + ' of ' + cutN + ' live rows, ' + zone + ', read ' + SWEEP.clock;
      return { label: dd[0], count: ageCounts[i], h: Math.max(2, Math.round((ageCounts[i] / ageMax) * 168)),
        fill: i === 0 ? 'var(--accent)' : i === 1 ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--color-foreground)',
        stroke: i <= 1 ? 'var(--accent)' : 'var(--color-foreground)',
        ink: i <= 1 ? 'var(--accent)' : 'var(--color-muted)', aria: text, readKey: 'age' };
    });
    var in48 = AGG.in48, in96 = AGG.in96, past14 = AGG.past14;

    // ---- geography
    var geoArr = (AGG.geo || []).slice();
    var geoMax = geoArr.length ? geoArr[0].n : 1;
    var geo = geoArr.map(function (g) {
      var share = g.n ? Math.round((g.remote / g.n) * 100) : 0;
      var text = g.region + ': ' + g.n + ' live rows, ' + g.remote + ' open to remote, ' + share + '% remote share, read ' + SWEEP.clock;
      return { region: g.region, n: g.n, pct: Math.round((g.n / geoMax) * 100),
        remotePctOfMax: Math.round((g.remote / geoMax) * 100), aria: text, readKey: 'geo' };
    });

    // ---- tier 2 young record (one published sweep; earlier nights are gaps).
    var nightDefs = [];
    for (var _nd = 6; _nd >= 1; _nd--) nightDefs.push({ key: dstr(_nd).slice(5), on: false, future: false });
    nightDefs.push({ key: 'tonight', on: true, future: false });
    nightDefs.push({ key: dstr(-1).slice(5), on: false, future: true });
    var nights = nightDefs.map(function (nn) {
      var n = nn.key; var on = nn.on; var future = nn.future;
      return { night: on ? SWEEP.clock.slice(5) : n, label: on ? String(cutN) : (future ? 'next' : 'no record'),
        font: on ? 'var(--font-mono)' : 'var(--font-sans)',
        labelInk: on ? 'var(--color-foreground)' : 'var(--color-line-strong)',
        h: on ? 104 : 18, bg: on ? 'var(--accent)' : 'transparent',
        border: on ? '1px solid var(--accent)' : '1px dashed var(--color-line-strong)' };
    });

    // ---- pipeline
    var indMax = INDUSTRY.length ? INDUSTRY[0][1] : 1;
    var industries = INDUSTRY.map(function (x) {
      var weighted = Math.round(x[1] * x[2] / 100);
      var text = x[0] + ': ' + x[1] + ' rows on the pipeline, median fit ' + x[2] + ', ' + weighted + ' fit weighted, read ' + SWEEP.clock;
      return { name: x[0], n: x[1], fit: x[2], pct: Math.round((x[1] / indMax) * 100),
        wpct: Math.round((weighted / indMax) * 100), aria: text, readKey: 'industry' };
    });
    var prospectTotal = DATA.prospectTotal, prospectPre = DATA.prospectPre, prospectPosted = DATA.prospectPosted;
    var teamMax = Math.max.apply(null, TEAM.map(function (t) { return t[1]; }).concat([1]));
    var teamBuckets = TEAM.map(function (t) {
      var text = 'teams of ' + t[0] + ': ' + t[1] + ' of ' + prospectTotal + ' pipeline rows' + (t[2] ? ', inside the band where no designer exists yet' : '') + ', read ' + SWEEP.clock;
      return { label: t[0], count: t[1], h: Math.max(2, Math.round((t[1] / teamMax) * 138)),
        fill: t[2] ? 'var(--accent)' : 'color-mix(in srgb, var(--color-foreground-inverse) 55%, transparent)',
        ink: t[2] ? 'var(--accent)' : 'var(--color-muted-inverse)', aria: text, readKey: 'team' };
    });
    var bandRows = TEAM.filter(function (t) { return t[2]; }).reduce(function (a, t) { return a + t[1]; }, 0);

    return {
      stamp: SWEEP.stamp,
      liveN: liveN, cutN: cutN, cutLabel: cutLabel,
      pending: st.pending, failed: st.failed,
      killCutLabel: (noTitles ? 'whole archive' : 'archive cut to your families') + ' · ' + killCutN + ' of ' + KAGG.archiveTotal + ' rows',
      archiveTotal: KAGG.archiveTotal,

      funnel: [
        { n: String(SWEEP.observed), label: 'postings observed', note: 'across ' + SWEEP.boards + ' boards', ink: 'var(--color-foreground)' },
        { n: SWEEP.pulled, label: 'reached a verdict', note: 'pulled and read field by field', ink: 'var(--color-foreground)' },
        { n: SWEEP.verified, label: 'verified live', note: 'still there at the source', ink: 'var(--color-foreground)' },
        { n: SWEEP.killed, label: 'came down by rule', note: 'published with the evidence', ink: 'var(--accent)' }
      ],

      observedN: String(SWEEP.observed),
      stickyPos: st.watchOpen ? 'static' : 'sticky',
      watchOpen: st.watchOpen, watchClosed: !st.watchOpen,
      watchOpenStr: st.watchOpen ? 'true' : 'false',
      watchToggleLabel: st.watchOpen ? 'Close controls' : 'Open controls',
      watchToggleGlyph: st.watchOpen ? '−' : '+',

      filterSummary: segParts.length > 1 ? segParts.slice(1).join(' · ') + ' · ' + cutN + ' rows' : 'none set',
      shelves: [
        { label: 'Titles in the cut', note: 'every view below follows these', items: allViews, has: allViews.length > 0, none: allViews.length === 0,
          emptyNote: 'No title set. The page is reading all ' + liveN + ' live rows on the board. Search a title above to cut every view to it.' }
      ],
      query: st.query,
      results: results, hasResults: results.length > 0,
      noResults: q.length >= 2 && results.length === 0,
      searchNote: q.length < 2 ? 'type at least two letters'
        : results.length + (results.length === 1 ? ' title matches' : ' titles match') + ' on the board',
      controlRows: [
        { label: 'where', chips: ['anywhere', 'remote only', 'in office'].map(function (c) { return chip(c, st.where === c, 'set-where', c, facet('where', c)); }) },
        { label: 'pay printed', chips: [['any', 'any'], ['priced', 'range printed'], ['unpriced', 'no range']].map(function (c) { return chip(c[1], st.priced === c[0], 'set-priced', c[0], facet('priced', c[0])); }) },
        { label: 'posted within', chips: [[0, 'any'], [2, '48h'], [4, '96h'], [7, '7d'], [14, '14d']].map(function (c) { return chip(c[1], st.age === c[0], 'set-age', c[0], facet('age', c[0])); }) },
        { label: 'level', chips: [['any', 'any'], ['Senior', 'Senior'], ['Staff', 'Staff'], ['Lead', 'Lead'], ['Director', 'Director']].map(function (c) { return chip(c[1], st.level === c[0], 'set-level', c[0], facet('level', c[0])); }) },
        // The applicant-system buttons are the systems the crawl actually holds,
        // commonest first, rather than a hand-written list. The old list named
        // Ashby, Greenhouse and a "custom page" button that matched nothing,
        // because no row ever carried that value.
        { label: 'applicant system', chips: [{ key: 'any', label: 'any' }].concat(FACTS.atsOptions.slice(0, 7).map(function (a) { return { key: a.key, label: atsLabel(a.key) }; }))
            .map(function (c) { return chip(c.label, st.ats === c.key, 'set-ats', c.key, facet('ats', c.key)); }) },
        { label: 'pay floor', chips: [[0, 'any'], [150, '150k+'], [200, '200k+'], [250, '250k+'], [300, '300k+']].map(function (c) { return chip(c[1], st.floor === c[0], 'set-floor', c[0], facet('floor', c[0])); }) }
      ],
      floorNote: 'A pay floor keeps the ' + unpricedCut + ' rows in this cut that print no range, because an absent range is not a number below your floor. Use pay printed to drop them.',
      moreOpen: st.moreOpen,
      moreLabel: st.moreOpen ? 'Fewer filters' : 'More filters',
      moreGlyph: st.moreOpen ? '−' : '+',
      moreOpenStr: st.moreOpen ? 'true' : 'false',
      // APPLY FRICTION IS NOW MEASURED. It used to read 'easy' on every row
      // because the value was a literal, so this control could not move a
      // number. It now reads the applicant system's own apply flow: hard means
      // the applicant must hold an account with that system before the form can
      // be reached. See src/lib/jobs-derived.mjs for how each was checked.
      //
      // KILL RISK IS NOT HERE. That control existed and every row read 'LOW',
      // also a literal. Nothing in the crawl defines what it was measuring, so
      // it is hidden rather than shown as a filter that cannot move anything.
      moreRows: [
        { label: 'apply friction', chips: [['any', 'any'], ['easy', 'easy, no account'], ['hard', 'account needed']].map(function (c) { return chip(c[1], st.friction === c[0], 'set-friction', c[0], facet('friction', c[0])); }) },
        { label: 'issuer record', chips: [['any', 'any issuer'], ['clean', 'no kills on record'], ['lowchurn', 'under 10 reposts']].map(function (c) { return chip(c[1], st.record === c[0], 'set-record', c[0], facet('record', c[0])); }) }
      ],
      weightChips: [['title', 30], ['where', 25], ['pay', 20], ['freshness', 15], ['friction', 10]].map(function (w) { return { label: w[0], value: w[1] }; }),

      // The row table and the TSV export are gone (2026-09-23): this page is a
      // wall of charts and readings, and no endpoint behind it returns a
      // posting, so there is nothing to list or to hand over.

      payAxis: [120, 180, 240, 300, 350].map(function (v) { return { label: '$' + v + 'k', pct: payPct(v) }; }),
      ladder: ladder,
      ladderAria: 'Posted pay by seniority. ' + ladder.map(function (l) { return l.aria || l.tier + ' has no priced rows'; }).join('. '),
      readLadder: st.read.ladder || step,

      placeSplit: placeSplit,
      placeAria: 'Posted pay for remote against in office rows. ' + placeSplit.map(function (l) { return l.aria || l.tier + ' has no priced rows'; }).join('. '),
      readPlace: st.read.place || placeRead,
      placeCaveat: placeCaveat,

      scatter: scatter, scatterMedX: payPct(midMed), scatterMedY: fitScaleY(fitMed),
      scatterQuadLabel: 'high fit, high pay: ' + quadN,
      scatterAria: 'Density of fit score against posted pay midpoint across ' + pricedN + ' priced rows in this cut. ' + quadN + ' rows sit above both medians.',
      readScatter: st.read.scatter || (pricedN
        ? 'n ' + pricedN + ' priced' + ' · median fit ' + fitMed + ' · median midpoint $' + midMed + 'k · ' + quadN + ' rows clear both · ' + unpricedCut + ' rows in this cut print no range'
        : 'No priced rows in this cut, so nothing can be plotted here.'),

      bandBuckets: bandBuckets,
      bandAria: 'Distribution of posted range width over the posted floor across ' + bandN + ' priced rows.',
      readBand: st.read.band || (bandMed !== null
        ? 'median band ' + bandMed + '% of the floor · n ' + bandN + ' priced rows · read ' + SWEEP.clock
        : 'No priced rows in this cut, so no band can be read.'),

      dragRows: dragRows, dragReading: dragReading,
      readDrag: st.read.drag || 'hover or focus a bar for its average, its zero count, and the night it was read',

      issuers: issuerRows, issuerCols: issuerCols,
      sortNote: 'sorted by ' + colName[sortKey] + ', ' + (st.sort.dir === 'desc' ? 'high to low' : 'low to high'),
      issuerNote: issuerRows.length + ' issuers with a live row in this cut or a kill on record',
      redactState: named ? 'names shown, paid surface' : 'names held, public surface',
      namedStr: named ? 'true' : 'false',
      namedLabel: named ? 'Hold names' : 'Name the issuers',
      namedBorder: named ? 'var(--accent)' : 'var(--color-line-strong)',
      namedBg: named ? 'var(--accent)' : 'transparent',
      namedInk: named ? 'var(--accent-ink)' : 'var(--color-foreground)',

      heatCols: atsCols, heatRows: heatRows,
      heatAria: 'Crosstab of kill rule against applicant system across ' + killCutN + ' archive rows in this cut.',
      readHeat: st.read.heat || 'hover or focus a cell for its count and the night the archive was read',
      heatReading: heatReading,

      lifeRows: lifeRows,
      lifeAxis: [0, 10, 20, 30, 40].map(function (v) { return { label: v + 'd', pct: Math.round((v / LIFE_HI) * 100) }; }),
      lifeAria: 'Days standing before the kill, by rule, across ' + killCutN + ' archive rows.',
      readLife: st.read.life || 'hover or focus a box for the median, the middle half, and the range',

      churnBuckets: churnBuckets,
      churnAria: 'Distribution of how many times the same posting was killed and came back, across ' + killCutN + ' archive rows.',
      readChurn: st.read.churn || (killCutN ? 'n ' + killCutN + ' archive rows · highest in this cut ' + firedMax + ' returns on one posting' : 'No archive rows in this cut.'),

      ageBuckets: ageBuckets, zone48: 12.5, zone96w: 12.5,
      ageAria: 'Live rows by age against the arrival curve. ' + in48 + ' rows inside 48 hours, ' + in96 + ' inside 96 hours, ' + past14 + ' past 14 days.',
      readAge: st.read.age || (in48 + ' of ' + cutN + ' rows in this cut are still inside the first 48 hours · ' + in96 + ' inside 96 · ' + past14 + ' past 14 days · read ' + SWEEP.clock),
      stakes: [
        { fact: '45% of applications arrive within 48 hours of a posting going up, and 60% within 96 hours', source: 'NBER WP 32320, 125M applications', read: 'The first two bars above are the whole head start. Everything right of them is a crowded queue.' },
        { fact: 'Median posting life is 7 days; only a quarter stay up past two weeks', source: 'source on file, see method', read: 'So the long bars on the right are unusual rows, not the normal shape of the market.' },
        { fact: 'Median time to first fill runs 71 days for senior roles and 75 for technical', source: 'Ashby Talent Trends 2026, 54M apps', read: 'A role past the curve is not a dead role. Age reads your head start, never the posting health.' },
        { fact: 'The average job now draws about 254 applications', source: 'source on file, see method', read: 'That is the queue you are joining. Being early is the only lever this page can hand you.' }
      ],

      geo: geo,
      geoAria: 'Live rows by region with remote share. ' + geo.map(function (g) { return g.aria; }).join('. '),
      readGeo: st.read.geo || (geo.length ? geo.length + ' regions carry a live row in this cut · read ' + SWEEP.clock : 'No live rows in this cut.'),

      nights: nights,
      youngAria: 'Market level night over night. One published sweep is on the record, at ' + cutN + ' rows. Earlier nights hold no published record and are drawn as gaps.',
      recordOpened: SWEEP.clock, nextPoint: dstr(-1),

      prospectTotal: prospectTotal, prospectPre: prospectPre, prospectPosted: prospectPosted,
      industries: industries,
      industryAria: 'Pipeline rows by industry, with median fit and fit weighted rows. ' + industries.map(function (i) { return i.aria; }).join('. '),
      readIndustry: st.read.industry || ('n ' + prospectTotal + ' pipeline rows · ' + INDUSTRY.length + ' industries · read ' + SWEEP.clock),
      teamBuckets: teamBuckets,
      teamAria: 'Pipeline rows by team size. ' + bandRows + ' rows sit in the 6 to 20 band.',
      readTeam: st.read.team || ('n ' + prospectTotal + ' pipeline rows · read ' + SWEEP.clock),
      teamReading: bandRows + ' of ' + prospectTotal + ' rows sit between 6 and 20 people, the band where a first design hire gets made.',
      signals: SIGNALS.map(function (s, i) { return { text: s[0], n: s[1], ink: 'var(--color-foreground-inverse)', weight: i === 0 ? '600' : '400' }; }),

      method: [
        { tag: 'measured', ink: 'var(--color-foreground)', text: 'Company, title, location, remote, applicant system, printed range, published date, first observed, status and apply friction are read at the company careers page on each sweep and stamped with the night they were read.' },
        { tag: 'computed', ink: 'var(--color-foreground)', text: 'Lifespan is killed date minus first published date, because the stored lifespan field is empty. Fit is the weighted sum of five components at 30, 25, 20, 15 and 10. Negotiation band is printed ceiling over printed floor. Medians, quartiles and shares on this page are computed from the rows in your cut, not from a cached total.' },
        { tag: 'absent', ink: 'var(--accent)', text: 'No range is printed on ' + (liveN - FACTS.pricedN) + ' of the ' + liveN + ' rows on the board. An absent range is shown as a gap in sans, never as a zero and never as a number below your floor.' },
        { tag: 'pending', ink: 'var(--accent)', text: 'Family is the applicant system department read at the source, a measured field. Seniority is read from the posted title (Senior, Staff, Lead, Director) and shown as title-derived, because no structured level field is collected; the exporter role_family and tier tags refine both when they ship. Market level night over night, pay drift and kill rate trend need a second published sweep and stay Tier 2 until the record holds two nights.' },
        { tag: 'held', ink: 'var(--color-muted)', text: 'Company names on kill rows and issuer rows are held on the public surface and shown on a paid one. Every kill row carries the rule it tripped and the dated evidence, and never a motive.' },
        { tag: 'not claimed', ink: 'var(--color-muted)', text: 'Nothing on this page states intent. A posting reposted 28 times is a count we measured. Why it came back is a mind state no sweep can read, so this page does not print one.' }
      ],

    };
  }

  // -------------------------------------------------------------------------
  // render(): concatenate every registered view into the mount node.
  // Views are pure functions on the vm: window.LEDGER_VIEWS.renderX(vm) -> HTML.
  // The order here is the page order; view agents own the markup, not the order.
  // -------------------------------------------------------------------------
  // The nine view functions, in page order. Each is a coarse section from one
  // view agent; registered on window.LEDGER_VIEWS by ledger-v4-views.js.
  var VIEW_ORDER = [
    'render_hero', 'render_shell', 'render_crosscuts', 'render_drag',
    'render_issuers', 'render_archive', 'render_clockview', 'render_pipeline',
    'render_method'
  ];

  function render() {
    if (!mount) return;
    var vm = renderVals(state);
    currentVm = vm;
    var views = window.LEDGER_VIEWS || {};
    var focus = captureFocus();
    var html = '';
    for (var i = 0; i < VIEW_ORDER.length; i++) {
      var fn = views[VIEW_ORDER[i]];
      if (typeof fn === 'function') {
        try { html += fn(vm); }
        catch (e) { html += '<!-- view ' + VIEW_ORDER[i] + ' threw: ' + String(e && e.message || e) + ' -->'; }
      }
    }
    mount.innerHTML = html;
    restoreFocus(focus);
  }

  // Search input focus + caret survive the full innerHTML replacement.
  function captureFocus() {
    var el = document.activeElement;
    if (el && mount.contains(el) && el.getAttribute && el.getAttribute('data-act') === 'query') {
      return { start: el.selectionStart, end: el.selectionEnd };
    }
    return null;
  }
  function restoreFocus(f) {
    if (!f) return;
    var el = mount.querySelector('[data-act="query"]');
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(f.start, f.end); } catch (e) { /* number inputs etc. */ }
  }

  // -------------------------------------------------------------------------
  // Mutations. add()/patch() mirror v4; the rest is the action table (3.4).
  // -------------------------------------------------------------------------
  function rerender() { render(); }

  // -------------------------------------------------------------------------
  // THE CUT LIVES ON THE SERVER. Every one of these actions changes which rows
  // the numbers describe, so it needs a new set of numbers rather than a new
  // pass over an array this page no longer holds. Everything else (sorting the
  // issuer table, opening a panel, the hover readings, naming the issuers) is
  // presentation over numbers already in hand and re-renders immediately.
  // -------------------------------------------------------------------------
  var CUT_ACTIONS = {
    'set-where': 1, 'set-priced': 1, 'set-age': 1, 'set-level': 1, 'set-ats': 1,
    'set-friction': 1, 'set-floor': 1, 'set-record': 1, 'clear-filters': 1,
    'watch-all': 1, 'add-watch': 1, 'add-raw': 1, 'remove-watch': 1,
    'toggle-variant': 1
  };

  /** The current filters as a query string the endpoint accepts. */
  function queryFor(st) {
    var q = [];
    st.watches.forEach(function (w) {
      q.push('watch=' + encodeURIComponent([w.title].concat(w.off).join('\t')));
    });
    if (st.where !== 'anywhere') q.push('where=' + encodeURIComponent(st.where));
    if (st.floor) q.push('floor=' + st.floor);
    if (st.priced !== 'any') q.push('priced=' + st.priced);
    if (st.age) q.push('age=' + st.age);
    if (st.level !== 'any') q.push('level=' + encodeURIComponent(st.level));
    if (st.ats !== 'any') q.push('ats=' + encodeURIComponent(st.ats));
    if (st.friction !== 'any') q.push('friction=' + st.friction);
    if (st.record !== 'any') q.push('record=' + st.record);
    return q.join('&');
  }

  // One request in flight at a time. A reader pressing four buttons quickly
  // should land on the fourth cut, not on whichever response happens to arrive
  // last, so every response carries the sequence number of the press that asked
  // for it and a stale one is dropped.
  var cutSeq = 0;
  var cutTimer = null;

  function refreshCut() {
    if (cutTimer) clearTimeout(cutTimer);
    state.pending = true;
    state.failed = '';
    render();
    // A short coalescing delay: pressing three buttons in a row is one request,
    // not three.
    cutTimer = setTimeout(function () {
      var seq = ++cutSeq;
      var qs = queryFor(state);
      fetch(SUMMARY_PATH + (qs ? '?' + qs : ''), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin'
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            throw new Error(body && body.error ? body.error : 'The numbers could not be read (' + res.status + ').');
          });
        }
        return res.json();
      }).then(function (body) {
        if (seq !== cutSeq) return; // a later press already asked for its own cut
        AGG = body.live || emptyAgg();
        KAGG = body.kills || emptyKagg();
        state.pending = false;
        state.failed = '';
        render();
      }).catch(function (err) {
        if (seq !== cutSeq) return;
        state.pending = false;
        state.failed = String(err && err.message || err);
        render();
      });
    }, 90);
  }

  function add(title, shelf) {
    title = (title || '').trim();
    if (!title) return;
    if (state.watches.some(function (w) { return w.title.toLowerCase() === title.toLowerCase(); })) { state.query = ''; return; }
    state.watches = state.watches.concat([{ id: 'w' + (++watchSeq), title: title, shelf: shelf, off: [], expanded: false }]);
    state.query = '';
  }
  function patchWatch(id, fn) {
    state.watches = state.watches.map(function (w) { return w.id === id ? fn(w) : w; });
  }

  function onClick(e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || !mount.contains(el)) return;
    var act = el.dataset.act;
    var val = el.dataset.val;
    switch (act) {
      case 'query': return; // handled on input
      case 'set-where': state.where = val; break;
      case 'set-priced': state.priced = val; break;
      case 'set-age': state.age = +val; break;
      case 'set-level': state.level = val; break;
      case 'set-ats': state.ats = val; break;
      case 'set-friction': state.friction = val; break;
      case 'set-record': state.record = val; break;
      case 'set-floor': state.floor = +val; break;
      case 'sort-issuers': {
        var col = el.dataset.col;
        state.sort = { key: col, dir: (state.sort.key === col && state.sort.dir === 'desc') ? 'asc' : 'desc' };
        break;
      }
      case 'toggle-more': state.moreOpen = !state.moreOpen; break;
      case 'toggle-watch': state.watchOpen = !state.watchOpen; break;
      case 'toggle-named': state.named = !state.named; break;
      case 'watch-all':
        state.watches = TITLE_INDEX.map(function (t, i) {
          return { id: 'a' + i, title: t.title, shelf: t.title === 'Design Leadership' ? 'stretch' : 'core', off: [], expanded: false };
        });
        break;
      case 'clear-filters':
        state.where = 'anywhere'; state.floor = 0; state.priced = 'any'; state.age = 0;
        state.level = 'any'; state.ats = 'any'; state.friction = 'any'; state.record = 'any';
        break;
      case 'add-watch': add(el.dataset.title, el.dataset.shelf || 'core'); break;
      case 'add-raw': add(state.query, 'core'); break;
      case 'remove-watch': {
        var rid = el.dataset.id;
        state.watches = state.watches.filter(function (w) { return w.id !== rid; });
        break;
      }
      case 'move-watch':
        patchWatch(el.dataset.id, function (w) { return Object.assign({}, w, { shelf: w.shelf === 'core' ? 'stretch' : 'core' }); });
        break;
      case 'toggle-expand':
        patchWatch(el.dataset.id, function (w) { return Object.assign({}, w, { expanded: !w.expanded }); });
        break;
      case 'toggle-variant': {
        var vstr = el.dataset.variant;
        patchWatch(el.dataset.id, function (w) {
          var off = w.off.indexOf(vstr) === -1 ? w.off.concat([vstr]) : w.off.filter(function (o) { return o !== vstr; });
          return Object.assign({}, w, { off: off });
        });
        break;
      }
      default: return;
    }
    if (CUT_ACTIONS[act]) refreshCut(); else rerender();
  }

  function onInput(e) {
    var el = e.target;
    if (!el || !el.dataset || el.dataset.act !== 'query') return;
    state.query = el.value;
    rerender();
  }

  // pointerover + focusin: the hover/focus readings. Guard against the
  // pointerover storm that a full re-render would otherwise cause by skipping
  // the rerender when the value is unchanged.
  function onRead(e) {
    var el = e.target.closest ? e.target.closest('[data-read-key]') : null;
    if (!el || !mount.contains(el)) return;
    var key = el.dataset.readKey;
    var text = el.dataset.readText;
    if (state.read[key] === text) return;
    state.read[key] = text;
    rerender();
  }

  // -------------------------------------------------------------------------
  // Init.
  // -------------------------------------------------------------------------
  function init() {
    if (!mount) return;
    document.addEventListener('antialgo:themechange', function (e) {
      state.theme = e.detail && e.detail.theme === 'dark' ? 'dark' : 'light';
      render();
    });
    mount.addEventListener('click', onClick);
    mount.addEventListener('input', onInput);
    mount.addEventListener('pointerover', onRead);
    mount.addEventListener('focusin', onRead);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for the view agents and for debugging.
  window.LEDGER = {
    render: render, refresh: refreshCut,
    get state() { return state; },
    get vm() { return currentVm; },
    get agg() { return AGG; },
    DATA: DATA
  };
})();
