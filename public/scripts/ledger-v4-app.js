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

  var SWEEP = DATA.SWEEP || {};
  var LIVE = DATA.LIVE || [];
  var KILLS = DATA.KILLS || [];
  var CO = DATA.CO || [];
  var ALIAS = DATA.ALIAS || {};
  var INDUSTRY = DATA.INDUSTRY || [];
  var TEAM = DATA.TEAM || [];
  var SIGNALS = DATA.SIGNALS || [];
  var TIERS = DATA.TIERS || ['Senior', 'Staff', 'Lead', 'Director'];
  var RULES = DATA.RULES || [];
  var PAY_LO = DATA.PAY_LO, PAY_HI = DATA.PAY_HI, LIFE_HI = DATA.LIFE_HI;
  var BOARD = LIVE; // v4's BOARD was every row incl. closed; the real board we hold is LIVE.

  // TITLE_INDEX arrives as data. Rehydrate the group tests (contract 1.6) by
  // title, so indexFor(...).test(row) works exactly as v4's did.
  var GROUP_TESTS = {
    'Product Designer': function (r) { return r.fam === 'product' && (r.tier === 'Senior' || r.tier === 'Staff'); },
    'Design Engineer': function (r) { return r.fam === 'design engineering' && (r.tier === 'Senior' || r.tier === 'Staff'); },
    'Brand Designer': function (r) { return r.fam === 'brand' && (r.tier === 'Senior' || r.tier === 'Staff'); },
    'Design Systems Designer': function (r) { return r.fam === 'design systems' && (r.tier === 'Senior' || r.tier === 'Staff'); },
    'Design Leadership': function (r) { return r.tier === 'Lead' || r.tier === 'Director'; }
  };
  var TITLE_INDEX = (DATA.TITLE_INDEX || []).map(function (t) {
    return { title: t.title, n: t.n, variants: t.variants, fams: t.fams, tiers: t.tiers,
      test: GROUP_TESTS[t.title] || function () { return false; } };
  });

  // -------------------------------------------------------------------------
  // Mount + state.
  // -------------------------------------------------------------------------
  var mount = document.getElementById('ledger-app');
  var watchSeq = 0;

  var state = {
    theme: (mount && mount.dataset.theme === 'dark') ? 'dark' : 'light',
    watches: [],
    where: 'anywhere', floor: 0, priced: 'any', age: 0, level: 'any',
    ats: 'any', friction: 'any', risk: 'any', record: 'any',
    moreOpen: false, rowsOpen: false, rowSort: 'fit', copied: false,
    watchOpen: false, query: '',
    named: !!(mount && mount.dataset.named === 'true'),
    sort: { key: 'kills', dir: 'desc' },
    read: {}
  };

  var currentVm = null; // the last view-model, so event handlers can read vm.tsv etc.

  // -------------------------------------------------------------------------
  // Helpers (copied from v4; the interactive closures are gone).
  // -------------------------------------------------------------------------
  function med(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }
  function quant(a, p) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? s[lo] : Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo));
  }
  function payPct(v) { return Math.max(0, Math.min(100, ((v - PAY_LO) / (PAY_HI - PAY_LO)) * 100)); }
  function fitPct(f) { return Math.max(0, Math.min(100, ((f - 30) / 70) * 100)); }

  var KILL_BY_CO = DATA.KILL_BY_CO || {};
  function coRecord(co) { return KILL_BY_CO[co] || { n: 0, reposts: 0, maxFired: 0 }; }
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
  // boxRow carries readKey (for data-read-key) instead of a hover closure.
  function boxRow(label, rows, key, hoverKey) {
    var vals = rows.filter(function (r) { return r.priced; }).map(function (r) { return r.mid; });
    var unpriced = rows.length - vals.length;
    if (!vals.length) {
      return { tier: label, stat: rows.length + ' rows', hasBox: false, noBox: true, emptyNote: 'No priced rows here in this cut.' };
    }
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var p25 = quant(vals, 0.25), p50 = med(vals), p75 = quant(vals, 0.75);
    var text = label + ': median $' + p50 + 'k, middle half $' + p25 + 'k to $' + p75 + 'k, range $' + lo + 'k to $' + hi + 'k, ' + vals.length + ' priced of ' + rows.length + ', read ' + SWEEP.clock;
    return {
      tier: label, hasBox: true, noBox: false,
      stat: 'n ' + rows.length + ' · priced ' + vals.length + ' · med $' + p50 + 'k',
      whiskL: payPct(lo), whiskW: payPct(hi) - payPct(lo),
      boxL: payPct(p25), boxW: Math.max(1.2, payPct(p75) - payPct(p25)),
      medL: payPct(p50), aria: text, unpriced: unpriced, readKey: hoverKey
    };
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

    var watched = st.watches.map(function (w) { return { w: w, idx: indexFor(w.title) }; });
    var noTitles = st.watches.length === 0;
    var matchesWatch = function (r) {
      if (noTitles) return true;
      return watched.some(function (x) {
        if (!x.idx || !x.idx.test(r)) return false;
        return x.w.off.indexOf(r.title) === -1;
      });
    };
    var passes = function (r, s) {
      if (!matchesWatch(r)) return false;
      if (s.where === 'remote only' && !r.remote) return false;
      if (s.where === 'in office' && r.remote) return false;
      if (s.floor && r.priced && r.min < s.floor) return false;
      if (s.priced === 'priced' && !r.priced) return false;
      if (s.priced === 'unpriced' && r.priced) return false;
      if (s.age && r.age !== null && r.age > s.age) return false;
      if (s.level !== 'any' && r.tier !== s.level) return false;
      if (s.ats !== 'any' && r.ats !== s.ats) return false;
      if (s.friction !== 'any' && r.friction !== s.friction) return false;
      if (s.risk !== 'any' && r.risk !== s.risk) return false;
      if (s.record === 'clean' && coRecord(r.co).n > 0) return false;
      if (s.record === 'lowchurn' && coRecord(r.co).maxFired >= 10) return false;
      return true;
    };
    var cut = LIVE.filter(function (r) { return passes(r, st); });
    var countWith = function (k, v) {
      var s = Object.assign({}, st); s[k] = v;
      return LIVE.filter(function (r) { return passes(r, s); }).length;
    };
    var cutSorted = cut.slice().sort(function (a, b) {
      if (st.rowSort === 'pay') {
        if (a.priced !== b.priced) return a.priced ? -1 : 1;
        if (a.priced) return b.mid - a.mid;
        return a.title.localeCompare(b.title);
      }
      if (st.rowSort === 'age') return (a.age === null ? Infinity : a.age) - (b.age === null ? Infinity : b.age);
      if (st.rowSort === 'title') return a.title.localeCompare(b.title);
      return b.fit - a.fit;
    });

    var famSet = {}, tierSet = {};
    watched.forEach(function (x) {
      if (!x.idx) return;
      x.idx.fams.forEach(function (f) { famSet[f] = 1; });
      x.idx.tiers.forEach(function (t) { tierSet[t] = 1; });
    });
    var killCut = KILLS.filter(function (k) {
      if (!noTitles && (!famSet[k.fam] || !tierSet[k.tier])) return false;
      if (st.level !== 'any' && k.tier !== st.level) return false;
      return true;
    });

    var titleCount = st.watches.length;
    var segParts = [];
    segParts.push(noTitles ? 'whole board, no title set' : titleCount + (titleCount === 1 ? ' title' : ' titles'));
    if (st.where !== 'anywhere') segParts.push(st.where);
    if (st.floor) segParts.push('floor $' + st.floor + 'k');
    if (st.priced === 'priced') segParts.push('range printed');
    if (st.priced === 'unpriced') segParts.push('no range printed');
    if (st.age) segParts.push('posted within ' + (st.age <= 4 ? st.age * 24 + 'h' : st.age + 'd'));
    if (st.level !== 'any') segParts.push(st.level);
    if (st.ats !== 'any') segParts.push(st.ats);
    if (st.friction !== 'any') segParts.push(st.friction + ' apply');
    if (st.risk !== 'any') segParts.push('risk ' + st.risk);
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
    var ladder = TIERS.map(function (t) { return boxRow(t, cut.filter(function (r) { return r.tier === t; }), 'mid', 'ladder'); });
    var ladderMeds = TIERS.map(function (t) {
      var v = cut.filter(function (r) { return r.tier === t && r.priced; }).map(function (r) { return r.mid; });
      return v.length ? med(v) : null;
    });
    var step = 'Not enough priced rows at two levels in this cut to read a step.';
    for (var li = 0; li < 3; li++) {
      if (ladderMeds[li] !== null && ladderMeds[li + 1] !== null) {
        var d = ladderMeds[li + 1] - ladderMeds[li];
        step = TIERS[li] + ' to ' + TIERS[li + 1] + ' is ' + (d >= 0 ? '+' : '') + '$' + d + 'k on posted midpoints, read ' + SWEEP.clock;
        break;
      }
    }

    // ---- cross cut 2: remote against onsite
    var remoteRows = cut.filter(function (r) { return r.remote; });
    var onsiteRows = cut.filter(function (r) { return !r.remote; });
    var placeSplit = [boxRow('Remote', remoteRows, 'mid', 'place'), boxRow('In office', onsiteRows, 'mid', 'place')];
    var rMed = med(remoteRows.filter(function (r) { return r.priced; }).map(function (r) { return r.mid; }));
    var oMed = med(onsiteRows.filter(function (r) { return r.priced; }).map(function (r) { return r.mid; }));
    var placeRead = 'One side of this split has no priced rows in this cut, so no comparison is printed.';
    var placeCaveat = 'A missing side is a gap in what employers printed, not a zero.';
    if (rMed !== null && oMed !== null) {
      var pd = rMed - oMed;
      placeRead = 'remote median $' + rMed + 'k · in office median $' + oMed + 'k · ' + (pd === 0 ? 'no gap' : (pd > 0 ? 'remote sits $' + pd + 'k above' : 'remote sits $' + Math.abs(pd) + 'k below')) + ' · read ' + SWEEP.clock;
      var oN = onsiteRows.filter(function (r) { return r.priced; }).length;
      placeCaveat = 'Only ' + oN + ' in-office rows print a range in this cut, so the in-office box moves fast. Read the count before the gap.';
    }

    // ---- cross cut 3: fit against pay
    var pricedCut = cut.filter(function (r) { return r.priced; });
    var pricedN = pricedCut.length;
    var mids = pricedCut.map(function (r) { return r.mid; });
    var fits = pricedCut.map(function (r) { return r.fit; });
    var midMed = mids.length ? med(mids) : 200;
    var fitMed = fits.length ? med(fits) : 70;
    // The fit axis scales to the data in this cut, not the theoretical 30-100:
    // real fit clusters high, so a fixed axis would pile every point at the top.
    // No y tick labels are printed, so this rescale mislabels nothing.
    var fitLo = fits.length ? Math.min.apply(null, fits) : 30;
    var fitHi = fits.length ? Math.max.apply(null, fits) : 100;
    var fitSpan = (fitHi - fitLo) || 1;
    var fitScaleY = function (f) { return Math.max(0, Math.min(100, ((f - fitLo) / fitSpan) * 92 + 4)); };
    // A readable scatter is hundreds of points, not thousands: sample by an even
    // stride, and jitter each point a hair so rows that share an integer fit
    // value do not stack into a solid bar. Deterministic (no Math.random), so it
    // is stable across renders. The quadrant count below is over ALL priced rows.
    var SCATTER_MAX = 500;
    var stride = Math.max(1, Math.ceil(pricedN / SCATTER_MAX));
    var jit = function (i) { var v = Math.sin((i + 1) * 12.9898) * 43758.5453; return (v - Math.floor(v)) - 0.5; };
    var scatter = [];
    for (var si = 0; si < pricedN; si += stride) {
      var sr = pricedCut[si];
      var hi = sr.fit >= fitMed && sr.mid >= midMed;
      var stext = (named ? sr.co : 'source held') + ' · ' + sr.title + ' · $' + sr.min + 'k to $' + sr.max + 'k · fit ' + sr.fit + ' · published ' + sr.published + ' · read ' + SWEEP.clock;
      scatter.push({
        x: Math.max(0, Math.min(100, payPct(sr.mid) + jit(si) * 2.2)),
        y: Math.max(0, Math.min(100, fitScaleY(sr.fit) + jit(si + 7) * 4.2)),
        aria: stext, readKey: 'scatter',
        fill: hi ? 'var(--accent)' : 'var(--color-foreground)', stroke: hi ? 'var(--accent)' : 'var(--color-foreground)'
      });
    }
    var quadN = pricedCut.filter(function (r) { return r.fit >= fitMed && r.mid >= midMed; }).length;
    var unpricedCut = cut.length - pricedN;

    // ---- cross cut 4: negotiation band
    var bands = pricedCut.map(function (r) { return (r.max - r.min) / r.min; });
    var bandDefs = [['under 15%', 0, 0.15], ['15 to 25%', 0.15, 0.25], ['25 to 35%', 0.25, 0.35], ['35 to 45%', 0.35, 0.45], ['45% and up', 0.45, 99]];
    var bandCounts = bandDefs.map(function (dd) { return bands.filter(function (b) { return b >= dd[1] && b < dd[2]; }).length; });
    var bandMax = Math.max.apply(null, bandCounts.concat([1]));
    var bandMed = bands.length ? Math.round(med(bands.map(function (b) { return Math.round(b * 1000); })) / 10) : null;
    var bandBuckets = bandDefs.map(function (dd, i) {
      var text = dd[0] + ' band on ' + bandCounts[i] + ' of ' + bands.length + ' priced rows, read ' + SWEEP.clock;
      return { label: dd[0], count: bandCounts[i], h: Math.max(2, Math.round((bandCounts[i] / bandMax) * 140)),
        fill: i >= 3 ? 'var(--accent)' : 'var(--color-foreground)', stroke: i >= 3 ? 'var(--accent)' : 'var(--color-foreground)',
        aria: text, readKey: 'band' };
    });

    // ---- fit drag
    var dragDefs = [['title and scope', 'title_scope', 30], ['where it is', 'remote_geo', 25], ['pay printed', 'comp', 20], ['freshness', 'freshness', 15], ['apply friction', 'apply_friction', 10]];
    var dragRows = dragDefs.map(function (dd) {
      var vals = cut.map(function (r) { return r.c[dd[1]]; });
      var avg = vals.length ? Math.round((vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) * 10) / 10 : 0;
      var zeros = vals.filter(function (v) { return v === 0; }).length;
      var pct = Math.round((avg / dd[2]) * 100);
      var text = dd[0] + ': average ' + avg + ' of ' + dd[2] + ' available, sits at zero on ' + zeros + ' of ' + cut.length + ' rows, read ' + SWEEP.clock;
      return { name: dd[0], weight: dd[2], avg: avg, pct: pct, zeros: zeros,
        fill: pct < 45 ? 'var(--accent)' : 'var(--color-foreground)',
        zeroNote: zeros === 0 ? 'Never sits at zero in this cut.' : 'Sits at zero on ' + zeros + ' of ' + cut.length + ' rows.',
        zeroInk: zeros > cut.length * 0.3 ? 'var(--accent)' : 'var(--color-muted)',
        aria: text, readKey: 'drag' };
    });
    var worst = dragRows.slice().sort(function (a, b) { return b.zeros - a.zeros; })[0];
    var dragReading = worst && worst.zeros > 0
      ? 'In this cut the drag is ' + worst.name + '. It earns nothing on ' + worst.zeros + ' of ' + cut.length + ' rows, which is what pulls the median score down. That is a property of the postings, not of your resume.'
      : 'In this cut no component sits at zero anywhere, which is rare. Scores here are moving on degree, not on absence.';

    // ---- issuer table
    var issuers = CO.map(function (c) {
      var rowsCo = cut.filter(function (r) { return r.co === c[0]; });
      var pr = rowsCo.filter(function (r) { return r.priced; }).map(function (r) { return r.mid; });
      var rem = rowsCo.filter(function (r) { return r.remote; }).length;
      var kb = KILL_BY_CO[c[0]] || { n: 0, reposts: 0, maxFired: 0 };
      return { co: c[0], ats: c[4], live: rowsCo.length, medNum: pr.length ? med(pr) : null,
        remoteNum: rowsCo.length ? Math.round((rem / rowsCo.length) * 100) : null,
        kills: kb.n, reposts: kb.reposts, maxFired: kb.maxFired };
    }).filter(function (r) { return r.live > 0 || r.kills > 0; });

    var sortKey = st.sort.key, dir = st.sort.dir === 'asc' ? 1 : -1;
    issuers.sort(function (a, b) {
      if (sortKey === 'co') return a.co.localeCompare(b.co) * dir;
      var av = a[sortKey === 'med' ? 'medNum' : sortKey === 'remote' ? 'remoteNum' : sortKey];
      var bv = b[sortKey === 'med' ? 'medNum' : sortKey === 'remote' ? 'remoteNum' : sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av === bv) return a.co.localeCompare(b.co);
      return (av - bv) * dir;
    });
    // One shared ranked order so the table alias and the TSV alias agree
    // (contract 1.5: kills desc, tie company name asc).
    var ranked = CO.slice().sort(function (a, b) { return b[2] - a[2] || a[0].localeCompare(b[0]); }).map(function (c) { return c[0]; });
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var issuerRows = issuers.map(function (r) {
      var idx = ranked.indexOf(r.co);
      var alias = 'source ' + (idx < 26 ? letters[idx] : idx + 1);
      return {
        name: named ? r.co : alias,
        nameFont: named ? 'var(--font-sans)' : 'var(--font-mono)',
        nameInk: named ? 'var(--color-foreground)' : 'var(--color-muted)',
        ats: r.ats, live: r.live,
        hasMed: r.medNum !== null, noMed: r.medNum === null,
        med: r.medNum !== null ? '$' + r.medNum + 'k' : '',
        remotePct: r.remoteNum === null ? 0 : r.remoteNum,
        remoteLabel: r.remoteNum === null ? '0%' : r.remoteNum + '%',
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

    // ---- kill archive crossed. The system columns are DERIVED from the data,
    // never hand-listed, so every board the sweep reads appears by name and none
    // is dropped. Columns come from all KILLS (stable across filtering).
    var COMPANY_SITE = 'the company site';
    var atsCounts = {};
    KILLS.forEach(function (k) { atsCounts[k.ats] = (atsCounts[k.ats] || 0) + 1; });
    var atsCols = Object.keys(atsCounts).sort(function (a, b) { return atsCounts[b] - atsCounts[a] || a.localeCompare(b); });
    if (!atsCols.length) atsCols = [COMPANY_SITE];
    var heatMax = Math.max.apply(null, RULES.map(function (rule) {
      return Math.max.apply(null, atsCols.map(function (a) {
        return killCut.filter(function (k) { return k.rule === rule && k.ats === a; }).length;
      }));
    }).concat([1]));
    var heatRows = RULES.map(function (rule) {
      return { rule: rule, cells: atsCols.map(function (a) {
        var n = killCut.filter(function (k) { return k.rule === rule && k.ats === a; }).length;
        var pct = Math.round((n / heatMax) * 100);
        var text = rule + ' on ' + a + ': ' + n + ' of ' + killCut.length + ' kills in this cut, archive read ' + SWEEP.clock;
        return { n: n, bg: n === 0 ? 'var(--color-surface)' : 'color-mix(in srgb, var(--accent) ' + Math.max(8, pct) + '%, var(--color-surface))',
          ink: pct > 55 ? 'var(--accent-ink)' : 'var(--color-foreground)', aria: text, readKey: 'heat' };
      }) };
    });
    var customKills = killCut.filter(function (k) { return k.ats === COMPANY_SITE; }).length;
    var customShare = killCut.length ? Math.round((customKills / killCut.length) * 100) : 0;
    var customLive = BOARD.length ? Math.round((BOARD.filter(function (r) { return r.ats === COMPANY_SITE; }).length / BOARD.length) * 100) : 0;
    var heatReading = 'Company career pages are ' + customLive + '% of the rows on the board and ' + customShare + '% of the kills in this cut. Read those postings twice before you spend an evening on one.';

    var lifeRows = [RULES[0], RULES[1], RULES[2]].map(function (rule) {
      var vals = killCut.filter(function (k) { return k.rule === rule && k.life !== null; }).map(function (k) { return k.life; });
      if (!vals.length) return { tier: rule, stat: '0 rows', hasBox: false, noBox: true, emptyNote: 'No kills on this rule in this cut.' };
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var p25 = quant(vals, 0.25), p50 = med(vals), p75 = quant(vals, 0.75);
      var pct = function (v) { return Math.max(0, Math.min(100, (v / LIFE_HI) * 100)); };
      var text = rule + ': median ' + p50 + ' days standing, middle half ' + p25 + ' to ' + p75 + ', range ' + lo + ' to ' + hi + ', n ' + vals.length + ', archive read ' + SWEEP.clock;
      return { tier: rule, stat: 'n ' + vals.length + ' · med ' + p50 + 'd', hasBox: true, noBox: false,
        whiskL: pct(lo), whiskW: pct(hi) - pct(lo), boxL: pct(p25), boxW: Math.max(1.2, pct(p75) - pct(p25)), medL: pct(p50),
        aria: text, readKey: 'life' };
    });
    var churnDefs = [['1', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4-5', 4, 5], ['6-9', 6, 9], ['10-15', 10, 15], ['16-28', 16, 28]];
    var churnCounts = churnDefs.map(function (dd) { return killCut.filter(function (k) { return k.fired >= dd[1] && k.fired <= dd[2]; }).length; });
    var churnMax = Math.max.apply(null, churnCounts.concat([1]));
    var firedMax = killCut.length ? Math.max.apply(null, killCut.map(function (k) { return k.fired; })) : 0;
    var churnBuckets = churnDefs.map(function (dd, i) {
      var text = 'fired ' + dd[0] + ' times: ' + churnCounts[i] + ' of ' + killCut.length + ' kills in this cut, archive read ' + SWEEP.clock;
      return { label: dd[0], count: churnCounts[i], h: Math.max(2, Math.round((churnCounts[i] / churnMax) * 142)),
        fill: i >= 5 ? 'var(--accent)' : 'var(--color-foreground)', aria: text, readKey: 'churn' };
    });

    // ---- head start (arrival curve). Null age fails every numeric compare and
    // is silently excluded, which is the honest outcome (contract 1.11).
    var ageDefs = [['0-1d', 0, 1], ['2d', 2, 2], ['3-4d', 3, 4], ['5-7d', 5, 7], ['8-14d', 8, 14], ['15-30d', 15, 30], ['1-3mo', 31, 90], ['3mo+', 91, 9999]];
    var ageCounts = ageDefs.map(function (dd) { return cut.filter(function (r) { return r.age !== null && r.age >= dd[1] && r.age <= dd[2]; }).length; });
    var ageMax = Math.max.apply(null, ageCounts.concat([1]));
    var ageBuckets = ageDefs.map(function (dd, i) {
      var zone = i === 0 ? 'inside 48 hours' : i === 1 ? '48 to 96 hours' : 'past 96 hours';
      var text = dd[0] + ' old: ' + ageCounts[i] + ' of ' + cut.length + ' live rows, ' + zone + ', read ' + SWEEP.clock;
      return { label: dd[0], count: ageCounts[i], h: Math.max(2, Math.round((ageCounts[i] / ageMax) * 168)),
        fill: i === 0 ? 'var(--accent)' : i === 1 ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--color-foreground)',
        stroke: i <= 1 ? 'var(--accent)' : 'var(--color-foreground)',
        ink: i <= 1 ? 'var(--accent)' : 'var(--color-muted)', aria: text, readKey: 'age' };
    });
    var in48 = cut.filter(function (r) { return r.age !== null && r.age <= 2; }).length;
    var in96 = cut.filter(function (r) { return r.age !== null && r.age <= 4; }).length;
    var past14 = cut.filter(function (r) { return r.age !== null && r.age > 14; }).length;

    // ---- geography
    var regions = {};
    cut.forEach(function (r) {
      if (!regions[r.region]) regions[r.region] = { n: 0, remote: 0 };
      regions[r.region].n++; if (r.remote) regions[r.region].remote++;
    });
    var geoArr = Object.keys(regions).map(function (k) { return { region: k, n: regions[k].n, remote: regions[k].remote }; });
    geoArr.sort(function (a, b) { return b.n - a.n; });
    var geoMax = geoArr.length ? geoArr[0].n : 1;
    var geo = geoArr.map(function (g) {
      var share = Math.round((g.remote / g.n) * 100);
      var text = g.region + ': ' + g.n + ' live rows, ' + g.remote + ' open to remote, ' + share + '% remote share, read ' + SWEEP.clock;
      return { region: g.region, n: g.n, pct: Math.round((g.n / geoMax) * 100),
        remotePctOfMax: Math.round((g.remote / geoMax) * 100), aria: text, readKey: 'geo' };
    });

    // ---- tier 2 young record (one published sweep; earlier nights are gaps).
    // Every label derives from the one clock, so nothing goes stale next sweep.
    var nightDefs = [];
    for (var _nd = 6; _nd >= 1; _nd--) nightDefs.push({ key: dstr(_nd).slice(5), on: false, future: false });
    nightDefs.push({ key: 'tonight', on: true, future: false });
    nightDefs.push({ key: dstr(-1).slice(5), on: false, future: true });
    var nights = nightDefs.map(function (nn) {
      var n = nn.key; var on = nn.on; var future = nn.future;
      return { night: on ? SWEEP.clock.slice(5) : n, label: on ? String(cut.length) : (future ? 'next' : 'no record'),
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

    var themeGlyph = st.theme === 'dark' ? 'Light' : 'Dark';

    // ---- TSV export string (built pure; the copy-cut handler writes it out)
    var tsvCols = ['title', 'issuer', 'level', 'family', 'where', 'remote', 'min_k', 'max_k', 'range_printed', 'published', 'age_days', 'fit', 'applicant_system', 'apply_friction', 'apply_minutes', 'kill_risk', 'issuer_kills', 'issuer_max_fired', 'first_observed'];
    var tsvBody = cutSorted.map(function (r) {
      var rec = coRecord(r.co);
      return [r.title, named ? r.co : ALIAS[r.co], r.tier, r.fam, r.place, r.remote ? 'yes' : 'no',
        r.priced ? r.min : '', r.priced ? r.max : '', r.priced ? 'yes' : 'no', r.published, r.age, r.fit,
        r.ats, r.friction, r.minutes, r.risk, rec.n, rec.maxFired, r.observed].join('\t');
    });
    var tsv = '# anti algo · the ledger · ' + cut.length + ' rows · ' + cutLabel + ' · read ' + SWEEP.stamp + '\n'
      + '# names ' + (named ? 'shown' : 'held, issuer column is an alias stable across sweeps') + '\n'
      + tsvCols.join('\t') + '\n' + tsvBody.join('\n');

    return {
      stamp: SWEEP.stamp,
      liveN: LIVE.length, cutN: cut.length, cutLabel: cutLabel,
      killCutLabel: (noTitles ? 'whole archive' : 'archive cut to your families') + ' · ' + killCut.length + ' of ' + KILLS.length + ' rows',
      archiveTotal: KILLS.length,

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

      filterSummary: segParts.length > 1 ? segParts.slice(1).join(' · ') + ' · ' + cut.length + ' rows' : 'none set',
      shelves: [
        { label: 'Titles in the cut', note: 'every view below follows these', items: allViews, has: allViews.length > 0, none: allViews.length === 0,
          emptyNote: 'No title set. The page is reading all ' + LIVE.length + ' live rows on the board. Search a title above to cut every view to it.' }
      ],
      query: st.query,
      results: results, hasResults: results.length > 0,
      noResults: q.length >= 2 && results.length === 0,
      searchNote: q.length < 2 ? 'type at least two letters'
        : results.length + (results.length === 1 ? ' title matches' : ' titles match') + ' on the board',
      controlRows: [
        { label: 'where', chips: ['anywhere', 'remote only', 'in office'].map(function (c) { return chip(c, st.where === c, 'set-where', c, countWith('where', c)); }) },
        { label: 'pay printed', chips: [['any', 'any'], ['priced', 'range printed'], ['unpriced', 'no range']].map(function (c) { return chip(c[1], st.priced === c[0], 'set-priced', c[0], countWith('priced', c[0])); }) },
        { label: 'posted within', chips: [[0, 'any'], [2, '48h'], [4, '96h'], [7, '7d'], [14, '14d']].map(function (c) { return chip(c[1], st.age === c[0], 'set-age', c[0], countWith('age', c[0])); }) },
        { label: 'level', chips: [['any', 'any'], ['Senior', 'Senior'], ['Staff', 'Staff'], ['Lead', 'Lead'], ['Director', 'Director']].map(function (c) { return chip(c[1], st.level === c[0], 'set-level', c[0], countWith('level', c[0])); }) },
        { label: 'applicant system', chips: [['any', 'any'], ['Ashby', 'Ashby'], ['Greenhouse', 'Greenhouse'], ['custom', 'custom page']].map(function (c) { return chip(c[1], st.ats === c[0], 'set-ats', c[0], countWith('ats', c[0])); }) },
        { label: 'pay floor', chips: [[0, 'any'], [150, '150k+'], [200, '200k+'], [250, '250k+'], [300, '300k+']].map(function (c) { return chip(c[1], st.floor === c[0], 'set-floor', c[0], countWith('floor', c[0])); }) }
      ],
      floorNote: 'A pay floor keeps the ' + unpricedCut + ' rows in this cut that print no range, because an absent range is not a number below your floor. Use pay printed to drop them.',
      moreOpen: st.moreOpen,
      moreLabel: st.moreOpen ? 'Fewer filters' : 'More filters',
      moreGlyph: st.moreOpen ? '−' : '+',
      moreOpenStr: st.moreOpen ? 'true' : 'false',
      moreRows: [
        { label: 'apply friction', chips: [['any', 'any'], ['easy', 'easy, no account'], ['medium', 'medium'], ['heavy', 'heavy']].map(function (c) { return chip(c[1], st.friction === c[0], 'set-friction', c[0], countWith('friction', c[0])); }) },
        { label: 'kill risk', chips: [['any', 'any'], ['LOW', 'LOW'], ['MED', 'MED'], ['HIGH', 'HIGH']].map(function (c) { return chip(c[1], st.risk === c[0], 'set-risk', c[0], countWith('risk', c[0])); }) },
        { label: 'issuer record', chips: [['any', 'any issuer'], ['clean', 'no kills on record'], ['lowchurn', 'under 10 reposts']].map(function (c) { return chip(c[1], st.record === c[0], 'set-record', c[0], countWith('record', c[0])); }) }
      ],
      weightChips: [['title', 30], ['where', 25], ['pay', 20], ['freshness', 15], ['friction', 10]].map(function (w) { return { label: w[0], value: w[1] }; }),

      rowsOpen: st.rowsOpen, rowsClosed: !st.rowsOpen,
      rowsOpenStr: st.rowsOpen ? 'true' : 'false',
      rowsToggleLabel: st.rowsOpen ? 'Hide the rows' : 'Read the rows',
      rowsToggleGlyph: st.rowsOpen ? '−' : '+',
      rowsCountNote: cut.length + (cut.length === 1 ? ' row' : ' rows') + ' · ' + pricedCut.length + ' priced'
        + (cut.length > 250 ? ' · showing the first 250, copy the cut for all ' + cut.length : '') + ' · read ' + SWEEP.stamp,
      rowSortChips: [['fit', 'fit'], ['pay', 'pay'], ['age', 'newest'], ['title', 'title']].map(function (c) { return chip(c[1], st.rowSort === c[0], 'set-rowsort', c[0]); }),
      rowTable: cutSorted.slice(0, 250).map(function (r) {
        var rec = coRecord(r.co);
        return {
          title: r.title,
          issuer: named ? r.co : ALIAS[r.co],
          issuerFont: named ? 'var(--font-sans)' : 'var(--font-mono)',
          level: r.tier, fam: r.fam,
          place: r.place,
          placeInk: r.remote ? 'var(--accent)' : 'var(--color-muted)',
          hasRange: r.priced, noRange: !r.priced,
          range: r.priced ? '$' + r.min + 'k - $' + r.max + 'k' : '',
          published: r.published,
          age: r.age === null ? 'No date shown' : (r.age === 0 ? 'today' : r.age + 'd'),
          ageInk: r.age === null ? 'var(--color-muted)' : (r.age <= 2 ? 'var(--accent)' : 'var(--color-foreground)'),
          fit: r.fit, ats: r.ats,
          friction: r.friction + (r.minutes != null ? ', ' + r.minutes + 'm' : ''),
          risk: r.risk,
          riskInk: r.risk === 'HIGH' ? 'var(--accent)' : r.risk === 'MED' ? 'var(--color-foreground)' : 'var(--color-muted)',
          recordNote: rec.n === 0 ? 'clean' : rec.n + ' kills, max ' + rec.maxFired + 'x',
          recordInk: rec.maxFired >= 10 ? 'var(--accent)' : 'var(--color-muted)'
        };
      }),
      rowCols: ['title', 'issuer', 'level', 'where', 'posted range', 'published', 'age', 'fit', 'system', 'friction', 'kill risk', 'issuer record'],
      copyLabel: st.copied ? 'Copied ' + cut.length + ' rows' : 'Copy the cut as TSV',
      copyInk: st.copied ? 'var(--accent)' : 'var(--color-foreground)',
      tsv: tsv,

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
      scatterAria: 'Scatter of fit score against posted pay midpoint for ' + pricedN + ' priced rows in this cut. ' + quadN + ' rows sit above both medians.',
      readScatter: st.read.scatter || (pricedN
        ? 'n ' + pricedN + ' priced' + (pricedN > scatter.length ? ' (a ' + scatter.length + ' point sample is plotted)' : '') + ' · median fit ' + fitMed + ' · median midpoint $' + midMed + 'k · ' + quadN + ' rows clear both · ' + unpricedCut + ' rows in this cut print no range'
        : 'No priced rows in this cut, so nothing can be plotted here.'),

      bandBuckets: bandBuckets,
      bandAria: 'Distribution of posted range width over the posted floor across ' + bands.length + ' priced rows.',
      readBand: st.read.band || (bandMed !== null
        ? 'median band ' + bandMed + '% of the floor · n ' + bands.length + ' priced rows · read ' + SWEEP.clock
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
      heatAria: 'Crosstab of kill rule against applicant system across ' + killCut.length + ' archive rows in this cut.',
      readHeat: st.read.heat || 'hover or focus a cell for its count and the night the archive was read',
      heatReading: heatReading,

      lifeRows: lifeRows,
      lifeAxis: [0, 10, 20, 30, 40].map(function (v) { return { label: v + 'd', pct: Math.round((v / LIFE_HI) * 100) }; }),
      lifeAria: 'Days standing before the kill, by rule, across ' + killCut.length + ' archive rows.',
      readLife: st.read.life || 'hover or focus a box for the median, the middle half, and the range',

      churnBuckets: churnBuckets,
      churnAria: 'Distribution of how many times the same posting was killed and came back, across ' + killCut.length + ' archive rows.',
      readChurn: st.read.churn || (killCut.length ? 'n ' + killCut.length + ' archive rows · highest in this cut ' + firedMax + ' returns on one posting' : 'No archive rows in this cut.'),

      ageBuckets: ageBuckets, zone48: 12.5, zone96w: 12.5,
      ageAria: 'Live rows by age against the arrival curve. ' + in48 + ' rows inside 48 hours, ' + in96 + ' inside 96 hours, ' + past14 + ' past 14 days.',
      readAge: st.read.age || (in48 + ' of ' + cut.length + ' rows in this cut are still inside the first 48 hours · ' + in96 + ' inside 96 · ' + past14 + ' past 14 days · read ' + SWEEP.clock),
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
      youngAria: 'Market level night over night. One published sweep is on the record, at ' + cut.length + ' rows. Earlier nights hold no published record and are drawn as gaps.',
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
        { tag: 'absent', ink: 'var(--accent)', text: 'No range is printed on ' + (LIVE.length - LIVE.filter(function (r) { return r.priced; }).length) + ' of the ' + LIVE.length + ' rows on the board. An absent range is shown as a gap in sans, never as a zero and never as a number below your floor.' },
        { tag: 'pending', ink: 'var(--accent)', text: 'Family is the applicant system department read at the source, a measured field. Seniority is read from the posted title (Senior, Staff, Lead, Director) and shown as title-derived, because no structured level field is collected; the exporter role_family and tier tags refine both when they ship. Market level night over night, pay drift and kill rate trend need a second published sweep and stay Tier 2 until the record holds two nights.' },
        { tag: 'held', ink: 'var(--color-muted)', text: 'Company names on kill rows and issuer rows are held on the public surface and shown on a paid one. Every kill row carries the rule it tripped and the dated evidence, and never a motive.' },
        { tag: 'not claimed', ink: 'var(--color-muted)', text: 'Nothing on this page states intent. A posting reposted 28 times is a count we measured. Why it came back is a mind state no sweep can read, so this page does not print one.' }
      ],

      themeGlyph: themeGlyph
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

  var copyTimer = null;

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
      case 'set-risk': state.risk = val; break;
      case 'set-record': state.record = val; break;
      case 'set-floor': state.floor = +val; break;
      case 'set-rowsort': state.rowSort = val; break;
      case 'sort-issuers': {
        var col = el.dataset.col;
        state.sort = { key: col, dir: (state.sort.key === col && state.sort.dir === 'desc') ? 'asc' : 'desc' };
        break;
      }
      case 'toggle-more': state.moreOpen = !state.moreOpen; break;
      case 'toggle-rows': state.rowsOpen = !state.rowsOpen; break;
      case 'toggle-watch': state.watchOpen = !state.watchOpen; break;
      case 'toggle-named': state.named = !state.named; break;
      case 'toggle-theme': {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', state.theme);
        break;
      }
      case 'watch-all':
        state.watches = TITLE_INDEX.map(function (t, i) {
          return { id: 'a' + i, title: t.title, shelf: t.title === 'Design Leadership' ? 'stretch' : 'core', off: [], expanded: false };
        });
        break;
      case 'clear-filters':
        state.where = 'anywhere'; state.floor = 0; state.priced = 'any'; state.age = 0;
        state.level = 'any'; state.ats = 'any'; state.friction = 'any'; state.risk = 'any'; state.record = 'any';
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
      case 'copy-cut':
        doCopy();
        return; // doCopy triggers its own rerenders
      default: return;
    }
    rerender();
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

  function doCopy() {
    var txt = currentVm ? currentVm.tsv : '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () {
        state.copied = true; rerender();
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(function () { state.copied = false; rerender(); }, 2400);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Init.
  // -------------------------------------------------------------------------
  function init() {
    if (!mount) return;
    document.documentElement.setAttribute('data-theme', state.theme);
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
  window.LEDGER = { render: render, get state() { return state; }, get vm() { return currentVm; }, DATA: DATA };
})();
