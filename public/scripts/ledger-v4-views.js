/* ledger-v4-views.js -- the nine view render functions, registered on
 * window.LEDGER_VIEWS and triggering the first render. Loaded after (defer)
 * ledger-v4-app.js. esc/escAttr are defined here; every other helper each view
 * needs is local to it (crosscuts' boxRow) or is CSS clamp(), not JS. */
(function(){
  'use strict';
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':'&gt;';}); }
  function escAttr(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&quot;':'&#39;';}); }

  // ---- view: hero ----
  // render_hero(vm) -> HTML string
  // Reproduces v4 template lines 1-32 (the <section id="read"> hero + Reality read funnel)
  // pixel-identically, with the contract's token map applied:
  //   --accent          -> --color-signal
  //   --font-mono       -> --font-family-mono
  //   --color-surface-2 -> --color-surface-raised
  // Pure: reads vm only, no clock, no DOM, no mutation. Gate 3 clean (no em/en dash, no curly quotes).
  function render_hero(vm) {
    // f.ink arrives from the vm as a token string ('var(--color-foreground)' or 'var(--accent)').
    // Normalize defensively so output is token-mapped whether or not the DATA layer already mapped it.
    const inkOf = (ink) => String(ink).split('--accent').join('--color-signal');
  
    // Verdict counts come from the funnel view-model, never hardcoded:
    //   funnel[2] = verified live (SWEEP.verified), funnel[3] = came down by rule (SWEEP.killed).
    const verifiedN = vm.funnel[2].n;
    const killedN = vm.funnel[3].n;
  
    const cells = vm.funnel.map((f) => `
                <div style="padding:14px;border-right:1px solid var(--color-line);border-bottom:1px solid var(--color-line);">
                  <div style="font-family:var(--font-family-mono);font-weight:600;font-size:1.5rem;letter-spacing:-0.02em;color:${inkOf(f.ink)};">${f.n}</div>
                  <div style="margin-top:4px;font-family:var(--font-family-mono);font-size:0.66rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-muted);">${f.label}</div>
                  <div style="margin-top:6px;font-size:0.82rem;line-height:1.45;color:var(--color-muted);">${f.note}</div>
                </div>`).join('');
  
    return `<section id="read" style="border-bottom:1px solid var(--color-line);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px) clamp(22px,3vw,34px);">
        <div data-two="" style="display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:clamp(22px,4vw,64px);align-items:start;">
          <div>
            <span style="font-family:var(--font-family-mono);font-size:0.72rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);display:inline-flex;align-items:center;gap:8px;"><span aria-hidden="true" style="width:7px;height:7px;background:var(--color-signal);border-radius:1px;"></span>Tonight's read</span>
            <h1 style="margin:16px 0 0;font-weight:600;font-size:clamp(1.9rem,4.2vw,3.1rem);line-height:1.04;letter-spacing:-0.03em;max-width:24ch;text-wrap:pretty;">Read the market in your sector like a data scientist.</h1>
            <p style="margin:18px 0 0;font-size:1.02rem;line-height:1.55;color:var(--color-muted);max-width:62ch;text-wrap:pretty;">Every night the sweep reads company careers pages directly, verifies what is still there, and publishes what came down by rule. This page is the structure underneath that: what pays, what is fresh, who recycles, and where roles are about to open. Nothing here reads a mind. Every number carries the night it was read.</p>
            <div style="margin-top:22px;display:flex;flex-wrap:wrap;gap:8px 10px;">
              <span style="font-family:var(--font-family-mono);font-size:0.68rem;border:1px solid var(--color-signal);padding:3px 9px;color:var(--color-muted);">tier one data: active</span>
              <span style="font-family:var(--font-family-mono);font-size:0.68rem;border:1px solid var(--color-line-strong);padding:3px 9px;color:var(--color-muted);">measurement set in mono</span>
              <span style="font-size:0.8rem;border:1px solid var(--color-line);padding:3px 9px;color:var(--color-muted);">absences and framing set in sans</span>
            </div>
          </div>
  
          <div style="border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
            <div style="padding:11px 14px;border-bottom:1px dashed var(--color-line-strong);display:flex;justify-content:space-between;gap:10px;align-items:baseline;">
              <span style="font-family:var(--font-family-mono);font-size:0.7rem;letter-spacing:0.12em;text-transform:uppercase;">Reality read</span>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;">TIER 1</span>
            </div>
            <div data-funnel="" style="display:grid;grid-template-columns:repeat(4,1fr);">${cells}
            </div>
            <p style="margin:0;padding:12px 14px;font-size:0.86rem;line-height:1.5;color:var(--color-muted);">Of the roles that reached a verdict last night, ${verifiedN} verified live at the source and ${killedN} tripped a standing rule. These are counts on one night, not a rate, and not a claim about anyone's intent.</p>
          </div>
        </div>
      </div>
    </section>`;
  }

  // ---- view: shell ----
  // Pure. render_shell(vm) -> HTML string for the "Set the cut" view (v4 template lines 35-254).
  // No DOM, no clock, no mutation. vm is the object returned by renderVals (Part 1/Part 3.2).
  function render_shell(vm) {
    const chipRow = g => `
                  <div data-two="" style="display:grid;grid-template-columns:132px minmax(0,1fr);gap:10px 16px;align-items:center;">
                    <span style="font-family:var(--font-family-mono);font-size:0.72rem;color:var(--color-muted);">${g.label}</span>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;">
                      ${g.chips.map(c => `
                      <button data-act="${c.act}" data-val="${c.val}" aria-pressed="${c.onStr}" style="min-height:36px;padding:8px 13px;cursor:pointer;border-radius:var(--radius);border:1px solid ${c.border};background:${c.bg};color:${c.ink};font-family:var(--font-family-mono);font-size:0.76rem;white-space:nowrap;display:inline-flex;gap:8px;align-items:baseline;">
                          <span>${c.label}</span><span style="opacity:0.55;">${c.count}</span>
                        </button>`).join('')}
                    </div>
                  </div>`;
  
    return `
    <div id="watch" style="position:${vm.stickyPos};top:var(--sticky-top, 84px);z-index:70;background:color-mix(in srgb, var(--color-surface) 95%, transparent);backdrop-filter:saturate(120%) blur(8px);border-top:1px solid var(--color-line-strong);border-bottom:1px solid var(--color-line-strong);">
      <div style="max-width:1400px;margin-inline:auto;padding:12px clamp(16px,4vw,56px) 14px;">
  
        <div style="display:flex;flex-wrap:wrap;gap:10px 20px;align-items:baseline;justify-content:space-between;">
          <span style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.74rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">01</span>
            <span style="font-family:var(--font-family-mono);font-size:0.74rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);white-space:nowrap;">Set the cut</span>
          </span>
          <span style="display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;">
            <button data-act="toggle-watch" aria-expanded="${vm.watchOpenStr}" aria-controls="watch-body" style="min-height:32px;padding:6px 11px;cursor:pointer;border:1px solid var(--color-line-strong);background:transparent;color:var(--color-foreground);font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;display:inline-flex;gap:8px;align-items:center;" data-hover="border-color:var(--color-foreground);"><span>${vm.watchToggleLabel}</span><span aria-hidden="true">${vm.watchToggleGlyph}</span></button>
          </span>
        </div>
  
        ${vm.watchClosed ? `
        <div style="padding:12px 0 0;display:flex;flex-direction:column;gap:10px;">
          <div style="display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px 16px;align-items:baseline;">
            <span style="font-family:var(--font-family-mono);font-size:0.68rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-muted);white-space:nowrap;">filters</span>
            <span style="font-family:var(--font-family-mono);font-size:0.78rem;">${vm.filterSummary}</span>
          </div>
        </div>` : ''}
  
        ${vm.watchOpen ? `
        <div id="watch-body">
          <h2 style="margin:20px 0 0;font-weight:600;font-size:clamp(1.4rem,3vw,2.1rem);line-height:1.08;letter-spacing:-0.025em;max-width:28ch;text-wrap:pretty;">Name a title. Every view on this page re-cuts to it.</h2>
          <p style="margin:12px 0 0;font-size:0.95rem;line-height:1.55;color:var(--color-muted);max-width:64ch;">There is no category list to pick from, because no list survives ${vm.observedN} postings a night. You type what you do, or what you want to do next. The board tells you what that title is called on the rows it read, and every cross-cut below follows your cut.</p>
  
          <div style="margin-top:22px;border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
            <div style="padding:14px 16px;border-bottom:1px solid var(--color-line);display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
              <input value="${vm.query}" data-act="query" placeholder="product designer, design engineer, brand, design systems" aria-label="Search the board's titles" style="flex:1;min-width:220px;min-height:44px;padding:11px 14px;border:1px solid var(--color-line-strong);background:var(--color-surface);color:var(--color-foreground);font-family:var(--font-family-mono);font-size:0.88rem;border-radius:var(--radius);">
              <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);white-space:nowrap;">${vm.searchNote}</span>
            </div>
            ${vm.hasResults ? `
            <div>
              ${vm.results.map(s => `
              <div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px 16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--color-line);">
                <div style="min-width:0;">
                  <div style="font-weight:600;font-size:0.96rem;">${s.title}</div>
                  <div style="margin-top:3px;font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${s.variantNote}</div>
                </div>
                <span style="font-family:var(--font-family-mono);font-size:0.78rem;color:var(--color-muted);white-space:nowrap;">${s.n} live</span>
                <span style="display:flex;gap:7px;">
                  <button data-act="add-watch" data-title="${s.title}" data-shelf="core" style="min-height:36px;padding:8px 14px;cursor:pointer;border:1px solid var(--color-foreground);background:var(--color-foreground);color:var(--color-surface);font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;" data-hover="opacity:0.88;">Add to cut</button>
                </span>
              </div>`).join('')}
            </div>` : ''}
            ${vm.noResults ? `
            <div style="padding:14px 16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;">
              <p style="margin:0;font-size:0.92rem;line-height:1.5;max-width:56ch;">No title on tonight's board reads like that. Watch it anyway and it joins the title filter on the next run, so it starts returning rows tomorrow morning.</p>
              <button data-act="add-raw" style="min-height:40px;padding:10px 16px;cursor:pointer;border:1px solid var(--color-foreground);background:var(--color-foreground);color:var(--color-surface);font-family:var(--font-family-mono);font-size:0.76rem;border-radius:var(--radius);white-space:nowrap;" data-hover="opacity:0.88;">Watch "${vm.query}" anyway</button>
            </div>` : ''}
          </div>
  
          <div style="margin-top:18px;">
            ${vm.shelves.map(sh => `
            <div style="border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
              <div style="padding:11px 16px;border-bottom:1px solid var(--color-line);display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
                <span style="font-family:var(--font-family-mono);font-size:0.72rem;letter-spacing:0.1em;text-transform:uppercase;">${sh.label}</span>
                <span style="font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);white-space:nowrap;">${sh.note}</span>
              </div>
              ${sh.has ? `
              <div>
                ${sh.items.map(w => `
                <div style="padding:14px 16px;border-bottom:1px solid var(--color-line);">
                  <div data-two="" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px;align-items:start;">
                    <div style="min-width:0;">
                      <div style="font-weight:600;font-size:0.96rem;">${w.title}</div>
                      <div style="margin-top:4px;font-family:var(--font-family-mono);font-size:0.7rem;color:${w.coverInk};">${w.liveNote}</div>
                    </div>
                    <div style="display:flex;gap:6px;">
                      <button data-act="remove-watch" data-id="${w.id}" aria-label="Remove ${w.title}" style="width:32px;height:32px;cursor:pointer;border:1px solid var(--color-line);background:transparent;color:var(--color-muted);font-family:var(--font-family-mono);font-size:0.8rem;line-height:1;border-radius:var(--radius);" data-hover="border-color:var(--color-foreground);color:var(--color-foreground);">\u00d7</button>
                    </div>
                  </div>
                  ${w.hasVariants ? `
                  <button data-act="toggle-expand" data-id="${w.id}" style="margin-top:10px;min-height:30px;padding:5px 10px;cursor:pointer;border:1px solid var(--color-line);background:transparent;color:var(--color-muted);font-family:var(--font-family-mono);font-size:0.7rem;border-radius:var(--radius);white-space:nowrap;" data-hover="border-color:var(--color-foreground);color:var(--color-foreground);">${w.expandLabel}</button>` : ''}
                  ${w.noVariants ? `
                  <p style="margin:10px 0 0;font-size:0.86rem;line-height:1.5;color:var(--color-muted);max-width:52ch;">Nothing matched yet. Tonight's run reads this title, and the strings it matches will appear here tomorrow.</p>` : ''}
                  ${w.expanded ? `
                  <div style="margin-top:10px;border-top:1px dashed var(--color-line);padding-top:10px;display:flex;flex-direction:column;gap:7px;">
                    <p style="margin:0 0 2px;font-size:0.86rem;line-height:1.5;color:var(--color-muted);">These are the exact strings the board matched. Switch off any that are not your job.</p>
                    ${w.variants.map(v => `
                    <button data-act="toggle-variant" data-id="${w.id}" data-variant="${v.s}" aria-pressed="${v.onStr}" style="display:flex;justify-content:space-between;gap:12px;align-items:center;text-align:left;min-height:34px;padding:7px 10px;cursor:pointer;border:1px solid ${v.border};background:${v.bg};color:${v.ink};font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);">
                      <span>${v.mark} ${v.s}</span>
                      <span style="opacity:0.7;">${v.n}</span>
                    </button>`).join('')}
                  </div>` : ''}
                </div>`).join('')}
              </div>` : ''}
              ${sh.none ? `
              <p style="margin:0;padding:16px;font-size:0.92rem;line-height:1.55;">${sh.emptyNote}</p>` : ''}
            </div>`).join('')}
          </div>
  
          <div style="margin-top:18px;border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
            <div style="padding:11px 16px;border-bottom:1px solid var(--color-line);display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;align-items:baseline;">
              <span style="font-family:var(--font-family-mono);font-size:0.72rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-muted);">True of any job</span>
              <span style="font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);">these are controls because they mean the same thing in every field</span>
            </div>
            <div style="padding:16px;display:flex;flex-direction:column;gap:14px;">
              ${vm.controlRows.map(chipRow).join('')}
              <p style="margin:0;font-size:0.84rem;line-height:1.5;color:var(--color-muted);max-width:86ch;">${vm.floorNote}</p>
  
              <div style="border-top:1px dashed var(--color-line);padding-top:13px;">
                <button data-act="toggle-more" aria-expanded="${vm.moreOpenStr}" aria-controls="more-filters" style="min-height:34px;padding:7px 12px;cursor:pointer;border:1px solid var(--color-line-strong);background:transparent;color:var(--color-foreground);font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);display:inline-flex;gap:8px;align-items:center;" data-hover="border-color:var(--color-foreground);"><span aria-hidden="true" style="color:var(--color-signal);">${vm.moreGlyph}</span><span>${vm.moreLabel}</span></button>
                ${vm.moreOpen ? `
                <div id="more-filters" style="margin-top:14px;display:flex;flex-direction:column;gap:14px;">
                  ${vm.moreRows.map(chipRow).join('')}
                  <p style="margin:0;font-size:0.84rem;line-height:1.5;color:var(--color-muted);max-width:86ch;">Kill risk is this page's own read on a live posting, from age, gating and applicant system. Issuer record comes from the standing archive, so it cuts live rows on their company's history.</p>
                </div>` : ''}
              </div>
  
              <div style="border-top:1px dashed var(--color-line);padding-top:13px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;">
                <span style="font-family:var(--font-family-mono);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-muted);">the board's weights</span>
                ${vm.weightChips.map(w => `
                <span style="font-family:var(--font-family-mono);font-size:0.72rem;color:var(--color-muted);white-space:nowrap;">${w.label} ${w.value}</span>`).join('')}
                <span style="font-size:0.84rem;color:var(--color-muted);">Fixed at the source, printed here so the fit drag below reads against them.</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;">
                <button data-act="clear-filters" style="min-height:34px;padding:7px 12px;cursor:pointer;border:1px solid var(--color-line);background:transparent;color:var(--color-muted);font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;" data-hover="border-color:var(--color-foreground);color:var(--color-foreground);">Clear filters</button>
              </div>
            </div>
          </div>
        </div>` : ''}
  
        <div style="margin-top:18px;border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
          <div style="padding:11px 16px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;min-width:0;">
              <span style="font-family:var(--font-family-mono);font-size:0.72rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-muted);">The rows in this cut</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
              <button data-act="copy-cut" style="min-height:34px;padding:7px 12px;cursor:pointer;border:1px solid var(--color-line-strong);background:transparent;color:${vm.copyInk};font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;" data-hover="border-color:var(--color-foreground);">${vm.copyLabel}</button>
              <button data-act="toggle-rows" aria-expanded="${vm.rowsOpenStr}" aria-controls="row-table" style="min-height:34px;padding:7px 12px;cursor:pointer;border:1px solid var(--color-foreground);background:transparent;color:var(--color-foreground);font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;display:inline-flex;gap:8px;align-items:center;" data-hover="background:var(--color-hover);"><span aria-hidden="true" style="color:var(--color-signal);">${vm.rowsToggleGlyph}</span><span>${vm.rowsToggleLabel}</span></button>
            </div>
          </div>
          ${vm.rowsOpen ? `
          <div id="row-table" style="border-top:1px solid var(--color-line);">
            <div style="padding:10px 16px;border-bottom:1px solid var(--color-line);display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;">
              <span style="font-family:var(--font-family-mono);font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-muted);">sort</span>
              ${vm.rowSortChips.map(c => `
              <button data-act="${c.act}" data-val="${c.val}" aria-pressed="${c.onStr}" style="min-height:32px;padding:6px 11px;cursor:pointer;border-radius:var(--radius);border:1px solid ${c.border};background:${c.bg};color:${c.ink};font-family:var(--font-family-mono);font-size:0.72rem;white-space:nowrap;">${c.label}</button>`).join('')}
            </div>
            <div style="overflow:auto;max-height:460px;">
              <table style="width:100%;min-width:1060px;">
                <thead>
                  <tr>
                    ${vm.rowCols.map(c => `
                    <th style="position:sticky;top:0;z-index:2;background:var(--color-surface);border-bottom:1px solid var(--color-line-strong);padding:9px 12px;text-align:left;font-family:var(--font-family-mono);font-size:0.66rem;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-muted);white-space:nowrap;">${c}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${vm.rowTable.map(r => `
                  <tr>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-size:0.84rem;white-space:nowrap;">${r.title}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:${r.issuerFont};font-size:0.8rem;white-space:nowrap;">${r.issuer}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.78rem;white-space:nowrap;">${r.level}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:${r.placeInk};white-space:nowrap;">${r.place}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;white-space:nowrap;">${r.hasRange ? `<span style="font-family:var(--font-family-mono);font-size:0.78rem;">${r.range}</span>` : ''}${r.noRange ? `<span style="font-size:0.8rem;color:var(--color-muted);">no range posted</span>` : ''}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:var(--color-muted);white-space:nowrap;">${r.published}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.78rem;color:${r.ageInk};white-space:nowrap;">${r.age}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.78rem;white-space:nowrap;">${r.fit}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:var(--color-muted);white-space:nowrap;">${r.ats}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:var(--color-muted);white-space:nowrap;">${r.friction}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:${r.riskInk};white-space:nowrap;">${r.risk}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:9px 12px;font-family:var(--font-family-mono);font-size:0.76rem;color:${r.recordInk};white-space:nowrap;">${r.recordNote}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <p style="margin:0;padding:11px 16px;border-top:1px solid var(--color-line-strong);font-size:0.84rem;line-height:1.5;color:var(--color-muted);">Every row is one posting read at its own careers page on the night stamped above. Age is computed against that clock, not against the time you are reading this. The copy action carries the same rows, the cut that produced them, and the stamp.</p>
          </div>` : ''}
        </div>
      </div>
    </div>`;
  }

  // ---- view: crosscuts ----
  // render_crosscuts(vm) -> HTML string
  // Reproduces the "Cross-cuts" section (v4 template lines 257-387) byte-for-byte,
  // with tokens mapped (--accent -> --color-signal, --font-mono -> --font-family-mono;
  // --color-surface-2 -> --color-surface-raised does not occur in this view).
  // vm keys consumed: ladderAria, ladder[], payAxis[], readLadder, placeAria,
  // placeSplit[], readPlace, placeCaveat, scatterAria, scatterMedX, scatterMedY,
  // scatter[], scatterQuadLabel, readScatter, bandAria, bandBuckets[], readBand.
  function render_crosscuts(vm) {
    const esc = s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
    // payAxis is rendered three times (pay ladder, remote-vs-onsite, fit-vs-pay).
    const payAxis = () => vm.payAxis.map(a =>
      `<span style="position:absolute;left:${a.pct}%;transform:translateX(-50%);">${esc(a.label)}</span>`
    ).join('');
  
    // A box-plot row shared shape (pay ladder + place split differ only in geometry).
    // readKey is the state.read bucket the hover/focus updates ('ladder' | 'place').
    const boxRow = (t, readKey, h, whiskTop, boxBottom, medBottom, emptyNote) => t.hasBox ? `
                  <div tabindex="0" data-read-key="${readKey}" data-read-text="${esc(t.aria)}" aria-label="${esc(t.aria)}" style="margin-top:6px;position:relative;height:${h}px;border-bottom:1px solid var(--color-line);">
                    <div style="position:absolute;top:${whiskTop}px;height:1px;left:${t.whiskL}%;width:${t.whiskW}%;background:var(--color-line-strong);"></div>
                    <div style="position:absolute;top:3px;bottom:${boxBottom}px;left:${t.boxL}%;width:${t.boxW}%;background:var(--color-hover);border:1px solid var(--color-line-strong);"></div>
                    <div style="position:absolute;top:0;bottom:${medBottom}px;left:${t.medL}%;width:2px;background:var(--color-signal);"></div>
                  </div>` : `
                  <p style="margin:6px 0 0;font-size:0.84rem;line-height:1.45;color:var(--color-muted);">${emptyNote}</p>`;
  
    return `
    <section id="crosscuts" style="border-bottom:1px solid var(--color-line);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">01</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">Cross-cuts</span>
          </div>
        </div>
        <h2 style="margin:14px 0 0;font-weight:600;font-size:clamp(1.5rem,3.2vw,2.3rem);line-height:1.08;letter-spacing:-0.025em;max-width:30ch;text-wrap:pretty;">Two variables at a time, because one variable hides the structure.</h2>
  
        <div data-charts="" style="margin-top:26px;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
  
          <!-- PAY LADDER -->
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Pay ladder by seniority</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:52ch;">What does the next level up actually pay tonight?</p>
            <div role="img" aria-label="${esc(vm.ladderAria)}" style="margin-top:20px;display:flex;flex-direction:column;gap:13px;">
              ${vm.ladder.map(t => `
                <div>
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
                    <span style="font-family:var(--font-family-mono);font-size:0.76rem;font-weight:500;">${esc(t.tier)}</span>
                    <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(t.stat)}</span>
                  </div>${boxRow(t, 'ladder', 24, 11, 5, 2, 'No priced rows at this level in this cut.')}
                </div>`).join('')}
            </div>
            <div aria-hidden="true" style="position:relative;height:14px;margin-top:10px;font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-line-strong);">
              ${payAxis()}
            </div>
            <p style="margin:14px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readLadder)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">Box spans the middle half of posted midpoints, the line inside it is the median, whiskers reach the lowest and highest range read tonight.</p>
          </div>
  
          <!-- REMOTE VS ONSITE -->
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Remote against in-office pay</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:52ch;">Is there a remote discount on this board, or a premium?</p>
            <div role="img" aria-label="${esc(vm.placeAria)}" style="margin-top:20px;display:flex;flex-direction:column;gap:18px;">
              ${vm.placeSplit.map(t => `
                <div>
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
                    <span style="font-family:var(--font-family-mono);font-size:0.76rem;font-weight:500;">${esc(t.tier)}</span>
                    <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(t.stat)}</span>
                  </div>${boxRow(t, 'place', 26, 12, 6, 3, 'No priced rows here in this cut.')}
                </div>`).join('')}
            </div>
            <div aria-hidden="true" style="position:relative;height:14px;margin-top:10px;font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-line-strong);">
              ${payAxis()}
            </div>
            <p style="margin:14px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readPlace)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">${esc(vm.placeCaveat)}</p>
          </div>
  
          <!-- FIT VS PAY -->
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Fit against pay</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <div style="margin:7px 0 0;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;align-items:baseline;">
              <p style="margin:0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:44ch;">Are the roles that suit you best also the ones that pay best?</p>
              <span style="font-family:var(--font-family-mono);font-size:0.66rem;color:var(--color-muted);white-space:nowrap;">${esc(vm.scatterQuadLabel)}</span>
            </div>
            <div role="img" aria-label="${esc(vm.scatterAria)}" style="margin-top:20px;position:relative;height:250px;border-left:1px solid var(--color-line-strong);border-bottom:1px solid var(--color-line-strong);">
              <div aria-hidden="true" style="position:absolute;left:${vm.scatterMedX}%;top:0;bottom:0;width:1px;background:var(--color-line);"></div>
              <div aria-hidden="true" style="position:absolute;bottom:${vm.scatterMedY}%;left:0;right:0;height:1px;background:var(--color-line);"></div>
              ${vm.scatter.map(p => `
              <span tabindex="0" data-read-key="scatter" data-read-text="${esc(p.aria)}" aria-label="${esc(p.aria)}" style="position:absolute;left:${p.x}%;bottom:${p.y}%;width:5px;height:5px;margin-left:-2.5px;margin-bottom:-2.5px;background:${p.fill};border-radius:1px;opacity:0.68;"></span>`).join('')}
            </div>
            <div aria-hidden="true" style="position:relative;height:14px;margin-top:6px;font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-line-strong);">
              ${payAxis()}
            </div>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readScatter)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">Vertical axis is your fit score, horizontal is the posted range midpoint. Hairlines are the medians of this cut. Rows with no range posted cannot appear here, and that absence is counted below.</p>
          </div>
  
          <!-- NEGOTIATION BAND -->
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Negotiation band</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:52ch;">How much room is the employer printing between the floor and the ceiling?</p>
            <div role="img" aria-label="${esc(vm.bandAria)}" style="margin-top:20px;display:flex;align-items:flex-end;gap:10px;height:180px;">
              ${vm.bandBuckets.map(b => `
                <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%;">
                  <span style="font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);">${esc(b.count)}</span>
                  <div tabindex="0" data-read-key="band" data-read-text="${esc(b.aria)}" aria-label="${esc(b.aria)}" style="width:100%;height:${b.h}px;background:${b.fill};border:1px solid ${b.stroke};"></div>
                  <span style="font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-muted);text-align:center;">${esc(b.label)}</span>
                </div>`).join('')}
            </div>
            <p style="margin:14px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readBand)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">Band is the printed ceiling over the printed floor. A wide band is room to negotiate into. It is not a promise, and it is not an offer.</p>
          </div>
  
        </div>
      </div>
    </section>`;
  }

  // ---- view: drag ----
  // Fit-component drag analysis view.
  // Pure: takes the view-model, returns an HTML string. No DOM, no clock, no mutation.
  // vm keys consumed: dragRows[] (each {name, weight, avg, pct, zeros, fill, zeroNote, zeroInk, aria}),
  //                   dragReading (string), readDrag (string).
  // Tokens mapped per contract: --font-mono -> --font-family-mono, --color-surface-2 -> --color-surface-raised.
  // (--accent arrives only inside d.fill, already mapped to --color-signal by the ported renderVals.)
  function render_drag(vm) {
    return `
    <section id="drag" style="border-bottom:1px solid var(--color-line);background:var(--color-surface-raised);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">02</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">Fit drag</span>
          </div>
        </div>
        <div data-two="" style="margin-top:14px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:clamp(20px,3vw,48px);align-items:start;">
          <div>
            <h2 style="margin:0;font-weight:600;font-size:clamp(1.5rem,3.2vw,2.3rem);line-height:1.08;letter-spacing:-0.025em;max-width:22ch;text-wrap:pretty;">Why the board scores low, component by component.</h2>
            <p style="margin:14px 0 0;font-size:0.95rem;line-height:1.55;color:var(--color-muted);max-width:52ch;text-wrap:pretty;">A fit score of 71 tells you nothing you can act on. The five parts underneath it do. Each part carries a fixed weight, and each one can sit at zero. Where a part sits at zero on many rows, that is the market moving, not you failing.</p>
            <p style="margin:16px 0 0;font-size:0.95rem;line-height:1.55;max-width:52ch;text-wrap:pretty;">${vm.dragReading}</p>
          </div>
          <div style="border:1px solid var(--color-line-strong);background:var(--color-surface);">
            <div style="padding:11px 16px;border-bottom:1px solid var(--color-line);display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <span style="font-family:var(--font-family-mono);font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;">Average earned of weight available</span>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;">TIER 1</span>
            </div>
            <div style="padding:16px;display:flex;flex-direction:column;gap:15px;">
              ${vm.dragRows.map(d => `
                <div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px 12px;justify-content:space-between;align-items:baseline;">
                    <span style="font-family:var(--font-family-mono);font-size:0.76rem;">${d.name}</span>
                    <span style="font-family:var(--font-family-mono);font-size:0.72rem;color:var(--color-muted);">${d.avg} of ${d.weight} \u00b7 ${d.pct}%</span>
                  </div>
                  <div tabindex="0" data-read-key="drag" data-read-text="${d.aria}" aria-label="${d.aria}" style="margin-top:6px;height:14px;background:var(--color-hover);border:1px solid var(--color-line);position:relative;">
                    <div style="height:100%;width:${d.pct}%;background:${d.fill};"></div>
                  </div>
                  <p style="margin:6px 0 0;font-size:0.84rem;line-height:1.45;color:${d.zeroInk};">${d.zeroNote}</p>
                </div>`).join('')}
            </div>
            <p style="margin:0;padding:12px 16px;border-top:1px dashed var(--color-line-strong);font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${vm.readDrag}</p>
          </div>
        </div>
      </div>
    </section>`;
  }

  // ---- view: issuers ----
  // Pure view renderer for section 03, "The issuers" (sortable issuer table).
  // Ported from v4 template lines 430-502. String-rendering, no inline handlers.
  // Token map applied: --accent -> --color-signal, --font-mono -> --font-family-mono,
  // --color-surface-2 -> --color-surface-raised. Gate 3 clean (no em/en dashes, no curly quotes).
  //
  // Consumes these vm keys (all produced by renderVals):
  //   archiveTotal, issuerNote, redactState, namedStr, namedLabel,
  //   namedBorder, namedBg, namedInk, sortNote,
  //   issuerCols: [{ key, label, align, justify, ink, glyph, ariaSort }]
  //   issuers:    [{ name, nameFont, nameInk, ats, live, hasMed, noMed, med,
  //                  remotePct, remoteLabel, kills, reposts, maxFired, killInk, firedInk }]
  //
  // NOTE: v4's issuerCols carry a `sort` closure but no column key. The delegated
  // dispatcher needs the key, so renderVals must add `key` (the colDefs c[0]:
  // 'co'|'live'|'med'|'remote'|'kills'|'reposts'|'maxFired') to each issuerCol.
  // Everything else is exactly the v4 vm.
  
  function render_issuers(vm) {
    const esc = (v) => String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  
    const cols = vm.issuerCols.map((c) => `
                    <th aria-sort="${esc(c.ariaSort)}" style="position:sticky;top:0;z-index:2;background:var(--color-surface);border-bottom:1px solid var(--color-line-strong);padding:0;text-align:${c.align};">
                      <button type="button" class="issuer-sort-btn" data-act="sort-issuers" data-col="${esc(c.key)}" style="width:100%;min-height:38px;padding:9px 12px;cursor:pointer;background:transparent;border:0;color:${c.ink};font-family:var(--font-family-mono);font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;text-align:${c.align};display:flex;gap:6px;align-items:center;justify-content:${c.justify};white-space:nowrap;">
                      <span>${esc(c.label)}</span><span aria-hidden="true" style="color:var(--color-signal);">${esc(c.glyph)}</span></button>
                    </th>`).join('');
  
    const rows = vm.issuers.map((r) => `
                  <tr>
                    <td style="position:sticky;left:0;background:var(--color-surface-raised);border-bottom:1px solid var(--color-line);border-right:1px solid var(--color-line);padding:10px 12px;">
                      <div style="display:flex;flex-direction:column;gap:2px;min-width:130px;">
                        <span style="font-family:${r.nameFont};font-size:0.86rem;font-weight:500;color:${r.nameInk};">${esc(r.name)}</span>
                        <span style="font-family:var(--font-family-mono);font-size:0.64rem;color:var(--color-muted);">${esc(r.ats)}</span>
                      </div>
                    </td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;text-align:right;font-family:var(--font-family-mono);font-size:0.82rem;">${esc(r.live)}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;text-align:right;">
                      ${r.hasMed ? `<span style="font-family:var(--font-family-mono);font-size:0.82rem;">${esc(r.med)}</span>` : ''}${r.noMed ? `<span style="font-size:0.8rem;color:var(--color-muted);">no range posted</span>` : ''}
                    </td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;">
                      <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;">
                        <div aria-hidden="true" style="width:52px;height:8px;background:var(--color-hover);border:1px solid var(--color-line);flex-shrink:0;"><div style="height:100%;width:${r.remotePct}%;background:var(--color-foreground);"></div></div>
                        <span style="font-family:var(--font-family-mono);font-size:0.78rem;white-space:nowrap;">${esc(r.remoteLabel)}</span>
                      </div>
                    </td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;text-align:right;font-family:var(--font-family-mono);font-size:0.82rem;color:${r.killInk};">${esc(r.kills)}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;text-align:right;font-family:var(--font-family-mono);font-size:0.82rem;color:var(--color-muted);">${esc(r.reposts)}</td>
                    <td style="border-bottom:1px solid var(--color-line);padding:10px 12px;text-align:right;">
                      <span style="font-family:var(--font-family-mono);font-size:0.82rem;color:${r.firedInk};">${esc(r.maxFired)}</span>
                    </td>
                  </tr>`).join('');
  
    return `
    <section id="issuers" style="border-bottom:1px solid var(--color-line);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">03</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">The issuers</span>
          </div>
        </div>
        <h2 style="margin:14px 0 0;font-weight:600;font-size:clamp(1.5rem,3.2vw,2.3rem);line-height:1.08;letter-spacing:-0.025em;max-width:30ch;text-wrap:pretty;">Every company as an issuer, with its record attached.</h2>
        <p style="margin:12px 0 0;font-size:0.95rem;line-height:1.55;color:var(--color-muted);max-width:66ch;text-wrap:pretty;">Which companies are hiring under your titles, what they pay, and what they have on the record behind them? Live columns follow your cut. Kill columns are the standing archive, ${esc(vm.archiveTotal)} rows deep.</p>
  
        <div style="margin-top:22px;border:1px solid var(--color-line-strong);background:var(--color-surface-raised);">
          <div style="padding:10px 14px;border-bottom:1px solid var(--color-line-strong);display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;">
            <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(vm.issuerNote)}</span>
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
              <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(vm.redactState)}</span>
              <button type="button" data-act="toggle-named" aria-pressed="${esc(vm.namedStr)}" style="min-height:34px;padding:7px 12px;cursor:pointer;border:1px solid ${vm.namedBorder};background:${vm.namedBg};color:${vm.namedInk};font-family:var(--font-family-mono);font-size:0.72rem;border-radius:var(--radius);white-space:nowrap;">${esc(vm.namedLabel)}</button>
            </div>
          </div>
          <div style="overflow:auto;max-height:470px;">
            <table style="width:100%;min-width:780px;">
              <thead>
                <tr>${cols}
                </tr>
              </thead>
              <tbody>${rows}
              </tbody>
            </table>
          </div>
          <div style="padding:11px 14px;border-top:1px solid var(--color-line-strong);display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between;">
            <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(vm.sortNote)}</span>
            <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">archive ${esc(vm.archiveTotal)} rows deep</span>
          </div>
        </div>
        <p style="margin:12px 0 0;font-size:0.84rem;line-height:1.5;color:var(--color-muted);max-width:78ch;">Max fired is the highest number of times one posting at that company came back after it was killed. A high number is a count we measured on the archive. It is not a statement about why.</p>
      </div>
    </section>`;
  }

  // ---- view: archive ----
  function render_archive(vm) {
    // Attribute/text escaper. aria/read-text values in this view are fixed vocab
    // (rule labels, ats buckets, integer counts, middot) so this only hardens
    // against special chars; it never alters the rendered pixels.
    const esc = s => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  
    // -- Panel 1: rule by applicant system heatmap
    const heat = `
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Rule by applicant system</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:46ch;">Which systems is it worth reading twice before you spend an evening applying?</p>
            <div role="img" aria-label="${esc(vm.heatAria)}" style="margin-top:20px;">
              <div style="display:grid;grid-template-columns:minmax(0,1fr) repeat(3,54px);gap:1px;">
                <span aria-hidden="true"></span>
                ${vm.heatCols.map(c => `<span style="font-family:var(--font-family-mono);font-size:0.66rem;text-align:center;padding-bottom:5px;">${esc(c)}</span>`).join('')}
                ${vm.heatRows.map(r => `<span style="font-family:var(--font-family-mono);font-size:0.7rem;padding:6px 8px 6px 0;text-align:right;color:var(--color-muted);line-height:1.25;">${esc(r.rule)}</span>${r.cells.map(c => `<span tabindex="0" data-read-key="heat" data-read-text="${esc(c.aria)}" aria-label="${esc(c.aria)}" style="display:flex;align-items:center;justify-content:center;height:34px;background:${c.bg};border:1px solid var(--color-line);font-family:var(--font-family-mono);font-size:0.76rem;color:${c.ink};">${esc(c.n)}</span>`).join('')}`).join('')}
              </div>
            </div>
            <p style="margin:14px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readHeat)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">${esc(vm.heatReading)}</p>
          </div>`;
  
    // -- Panel 2: lifespan by rule box-plots
    const life = `
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Lifespan by rule</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:46ch;">How long does each kind of dead posting stay up before it comes down?</p>
            <div role="img" aria-label="${esc(vm.lifeAria)}" style="margin-top:20px;display:flex;flex-direction:column;gap:16px;">
              ${vm.lifeRows.map(t => `<div>
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
                    <span style="font-family:var(--font-family-mono);font-size:0.74rem;">${esc(t.tier)}</span>
                    <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">${esc(t.stat)}</span>
                  </div>
                  ${t.hasBox ? `<div tabindex="0" data-read-key="life" data-read-text="${esc(t.aria)}" aria-label="${esc(t.aria)}" style="margin-top:6px;position:relative;height:24px;border-bottom:1px solid var(--color-line);">
                      <div style="position:absolute;top:11px;height:1px;left:${t.whiskL}%;width:${t.whiskW}%;background:var(--color-line-strong);"></div>
                      <div style="position:absolute;top:3px;bottom:5px;left:${t.boxL}%;width:${t.boxW}%;background:var(--color-hover);border:1px solid var(--color-line-strong);"></div>
                      <div style="position:absolute;top:0;bottom:2px;left:${t.medL}%;width:2px;background:var(--color-signal);"></div>
                    </div>` : `<p style="margin:6px 0 0;font-size:0.84rem;line-height:1.45;color:var(--color-muted);">${esc(t.emptyNote)}</p>`}
                </div>`).join('')}
            </div>
            <div aria-hidden="true" style="position:relative;height:14px;margin-top:10px;font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-line-strong);">
              ${vm.lifeAxis.map(a => `<span style="position:absolute;left:${a.pct}%;transform:translateX(-50%);">${esc(a.label)}</span>`).join('')}
            </div>
            <p style="margin:14px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readLife)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">Lifespan is the killed date minus the first published date we hold. The stored field is empty, so this is computed on read.</p>
          </div>`;
  
    // -- Panel 3: repost churn intensity histogram
    const churn = `
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Repost churn intensity</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:46ch;">How persistently does the same dead posting come back?</p>
            <div role="img" aria-label="${esc(vm.churnAria)}" style="margin-top:20px;display:flex;align-items:flex-end;gap:7px;height:176px;">
              ${vm.churnBuckets.map(b => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;height:100%;">
                  <span style="font-family:var(--font-family-mono);font-size:0.66rem;color:var(--color-muted);">${esc(b.count)}</span>
                  <div tabindex="0" data-read-key="churn" data-read-text="${esc(b.aria)}" aria-label="${esc(b.aria)}" style="width:100%;height:${b.h}px;background:${b.fill};"></div>
                  <span style="font-family:var(--font-family-mono);font-size:0.6rem;color:var(--color-muted);text-align:center;">${esc(b.label)}</span>
                </div>`).join('')}
            </div>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);">times the same posting was killed and came back</p>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readChurn)}</p>
            <p style="margin:8px 0 0;font-size:0.82rem;line-height:1.5;color:var(--color-muted);">The tail is the story. Most postings come back once. A handful come back until someone stops counting.</p>
          </div>`;
  
    return `
    <section id="archive" style="border-bottom:1px solid var(--color-line);background:var(--color-surface-raised);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">04</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">The kill archive, crossed</span>
          </div>
        </div>
        <h2 style="margin:14px 0 0;font-weight:600;font-size:clamp(1.5rem,3.2vw,2.3rem);line-height:1.08;letter-spacing:-0.025em;max-width:28ch;text-wrap:pretty;">Where the dead postings live, and how long they stood.</h2>
  
        <div data-three="" style="margin-top:24px;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr) minmax(0,1fr);gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
  ${heat}
  ${life}
  ${churn}
        </div>
      </div>
    </section>`;
  }

  // ---- view: clockview ----
  // render_clockview(vm) -> HTML string
  // Covers The Ledger v4 sections 05 "Head start" (#clockview) and the
  // "Geography + Tier 2" split. Pure: reads vm only, no clock, no DOM, no mutation.
  //
  // TOKEN ASSUMPTION: dynamic style values that arrive on the vm
  // (b.fill, b.stroke, b.ink, n.font, n.labelInk, n.bg, n.border) are already
  // token-mapped upstream, because contract 3.5 applies the global find/replace
  // (--accent -> --color-signal, --font-mono -> --font-family-mono,
  //  --color-surface-2 -> --color-surface-raised) inside renderVals. They are
  // interpolated verbatim. Every token written literally in THIS markup is mapped.
  function render_clockview(vm) {
    const esc = v => String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  
    return `
    <section id="clockview" style="border-bottom:1px solid var(--color-line);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-line-strong);">05</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">Head start</span>
          </div>
        </div>
        <h2 style="margin:14px 0 0;font-weight:600;font-size:clamp(1.5rem,3.2vw,2.3rem);line-height:1.08;letter-spacing:-0.025em;max-width:30ch;text-wrap:pretty;">How much of the arrival curve is left on this board.</h2>
        <p style="margin:12px 0 0;font-size:0.95rem;line-height:1.55;color:var(--color-muted);max-width:70ch;text-wrap:pretty;">Where does your cut sit against the hours when everyone else applies? Age is read from each posting's own published date against tonight's clock. The shaded zones are the arrival curve, not a countdown, and the fill note below says why.</p>
  
        <div style="margin-top:24px;border:1px solid var(--color-line-strong);background:var(--color-surface-raised);padding:clamp(18px,2.4vw,28px);">
          <div role="img" aria-label="${esc(vm.ageAria)}" style="position:relative;height:210px;display:flex;align-items:flex-end;gap:clamp(6px,1vw,14px);">
            <div aria-hidden="true" style="position:absolute;left:0;top:0;bottom:0;width:${vm.zone48}%;background:color-mix(in srgb, var(--color-signal) 9%, transparent);border-right:1px dashed var(--color-signal);"></div>
            <div aria-hidden="true" style="position:absolute;left:${vm.zone48}%;top:0;bottom:0;width:${vm.zone96w}%;background:color-mix(in srgb, var(--color-signal) 4%, transparent);border-right:1px dashed var(--color-line-strong);"></div>
            ${vm.ageBuckets.map(b => `
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%;position:relative;">
              <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:${b.ink};">${esc(b.count)}</span>
              <div tabindex="0" data-read-key="age" data-read-text="${esc(b.aria)}" aria-label="${esc(b.aria)}" style="width:100%;height:${b.h}px;background:${b.fill};border:1px solid ${b.stroke};"></div>
              <span style="font-family:var(--font-family-mono);font-size:0.64rem;color:var(--color-muted);text-align:center;">${esc(b.label)}</span>
            </div>`).join('')}
          </div>
          <div style="margin-top:16px;padding-top:14px;border-top:1px dashed var(--color-line-strong);display:flex;flex-wrap:wrap;gap:10px 22px;justify-content:space-between;align-items:baseline;">
            <span style="font-family:var(--font-family-mono);font-size:0.72rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readAge)}</span>
            <span style="display:flex;flex-wrap:wrap;gap:8px 16px;font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);">
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:var(--color-signal);"></span>inside 48 hours</span>
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:color-mix(in srgb, var(--color-signal) 45%, transparent);"></span>48 to 96 hours</span>
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:var(--color-foreground);"></span>past 96 hours</span>
            </span>
          </div>
        </div>
  
        <div data-stakes="" style="margin-top:22px;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
          ${vm.stakes.map(s => `
          <div style="background:var(--color-surface);padding:16px;display:flex;flex-direction:column;gap:7px;">
            <p style="margin:0;font-family:var(--font-family-mono);font-size:0.78rem;line-height:1.5;">${esc(s.fact)}</p>
            <p style="margin:0;font-family:var(--font-family-mono);font-size:0.64rem;color:var(--color-line-strong);">${esc(s.source)}</p>
            <p style="margin:auto 0 0;font-size:0.84rem;line-height:1.5;color:var(--color-muted);">${esc(s.read)}</p>
          </div>`).join('')}
        </div>
      </div>
    </section>
  
    <section style="border-bottom:1px solid var(--color-line);background:var(--color-surface-raised);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,44px) clamp(16px,4vw,56px);">
        <div data-two="" style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
  
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Where the live roles are</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-line);color:var(--color-line-strong);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:56ch;">Which regions are hiring under your titles, and how much of each region is open to remote?</p>
            <div role="img" aria-label="${esc(vm.geoAria)}" style="margin-top:20px;display:flex;flex-direction:column;gap:10px;">
              ${vm.geo.map(g => `
              <div style="display:grid;grid-template-columns:92px minmax(0,1fr) 44px;gap:12px;align-items:center;">
                <span style="font-family:var(--font-family-mono);font-size:0.72rem;white-space:nowrap;">${esc(g.region)}</span>
                <div tabindex="0" data-read-key="geo" data-read-text="${esc(g.aria)}" aria-label="${esc(g.aria)}" style="height:16px;background:var(--color-hover);border:1px solid var(--color-line);position:relative;">
                  <div style="position:absolute;left:0;top:0;bottom:0;width:${g.pct}%;background:var(--color-foreground);"></div>
                  <div style="position:absolute;left:0;top:0;bottom:0;width:${g.remotePctOfMax}%;background:var(--color-signal);"></div>
                </div>
                <span style="font-family:var(--font-family-mono);font-size:0.76rem;text-align:right;">${esc(g.n)}</span>
              </div>`).join('')}
            </div>
            <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px 16px;font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted);">
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:var(--color-signal);"></span>open to remote</span>
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:var(--color-foreground);"></span>in office</span>
            </div>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted);">${esc(vm.readGeo)}</p>
          </div>
  
          <div style="background:var(--color-surface);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1.04rem;font-weight:600;letter-spacing:-0.01em;">Market level, night over night</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-signal);color:var(--color-signal);padding:2px 6px;white-space:nowrap;">TIER 2 &middot; NEEDS HISTORY</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.88rem;line-height:1.5;color:var(--color-muted);max-width:52ch;">Is the market under your titles growing or thinning? This one cannot be answered yet, and will not be faked while it fills in.</p>
            <div role="img" aria-label="${esc(vm.youngAria)}" style="margin-top:22px;position:relative;height:150px;border-bottom:1px solid var(--color-line-strong);display:flex;align-items:flex-end;gap:8px;">
              ${vm.nights.map(n => `
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;height:100%;">
                <span style="font-family:${n.font};font-size:0.68rem;color:${n.labelInk};">${esc(n.label)}</span>
                <div style="width:100%;height:${n.h}px;background:${n.bg};border:${n.border};"></div>
                <span style="font-family:var(--font-family-mono);font-size:0.62rem;color:var(--color-muted);">${esc(n.night)}</span>
              </div>`).join('')}
            </div>
            <p style="margin:16px 0 0;font-size:0.92rem;line-height:1.55;max-width:50ch;">One published sweep is on the record. A trend needs a second, so tonight is a point and not a line. The dashed nights are where the record fills in, one sweep at a time.</p>
            <div style="margin-top:auto;padding-top:16px;">
              <div style="border-top:1px dashed var(--color-line-strong);padding-top:12px;display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:space-between;">
                <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-muted);">record opened ${esc(vm.recordOpened)}</span>
                <span style="font-family:var(--font-family-mono);font-size:0.7rem;color:var(--color-signal);">next point ${esc(vm.nextPoint)}</span>
              </div>
              <p style="margin:10px 0 0;font-size:0.84rem;line-height:1.5;color:var(--color-muted);">Pay drift and kill-rate trend sit behind the same gate. Both are listed in the method note as pending, not shown as flat lines.</p>
            </div>
          </div>
  
        </div>
      </div>
    </section>`;
  }

  // ---- view: pipeline ----
  function render_pipeline(vm) {
    const esc = v => String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = v => String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
    const industries = vm.industries.map(i => `
                <div style="display:grid;grid-template-columns:78px minmax(0,1fr) 34px 34px;gap:10px;align-items:center;">
                  <span style="font-family:var(--font-family-mono);font-size:0.7rem;white-space:nowrap;color:var(--color-foreground-inverse);">${esc(i.name)}</span>
                  <div tabindex="0" data-read-key="industry" data-read-text="${escAttr(i.aria)}" aria-label="${escAttr(i.aria)}" style="height:14px;background:color-mix(in srgb, var(--color-foreground-inverse) 12%, transparent);position:relative;">
                    <div style="position:absolute;left:0;top:0;bottom:0;width:${i.pct}%;background:color-mix(in srgb, var(--color-foreground-inverse) 55%, transparent);"></div>
                    <div style="position:absolute;left:0;top:0;bottom:0;width:${i.wpct}%;background:var(--color-signal);"></div>
                  </div>
                  <span style="font-family:var(--font-family-mono);font-size:0.72rem;text-align:right;color:var(--color-foreground-inverse);">${i.n}</span>
                  <span style="font-family:var(--font-family-mono);font-size:0.68rem;text-align:right;color:var(--color-muted-inverse);">${i.fit}</span>
                </div>`).join('');
  
    const teamBuckets = vm.teamBuckets.map(b => `
                <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:5px;height:100%;">
                  <span style="font-family:var(--font-family-mono);font-size:0.66rem;color:${b.ink};">${b.count}</span>
                  <div tabindex="0" data-read-key="team" data-read-text="${escAttr(b.aria)}" aria-label="${escAttr(b.aria)}" style="width:100%;height:${b.h}px;background:${b.fill};"></div>
                  <span style="font-family:var(--font-family-mono);font-size:0.6rem;color:var(--color-muted-inverse);text-align:center;">${esc(b.label)}</span>
                </div>`).join('');
  
    const signals = vm.signals.map(s => `
                <div style="background:var(--color-surface-inverse);padding:11px 0;display:grid;grid-template-columns:minmax(0,1fr) 48px;gap:12px;align-items:baseline;">
                  <span style="font-size:0.88rem;line-height:1.45;">"${esc(s.text)}"</span>
                  <span style="font-family:var(--font-family-mono);font-size:0.78rem;font-weight:${s.weight};text-align:right;color:${s.ink};">${s.n}</span>
                </div>`).join('');
  
    return `
    <section id="pipeline" style="border-bottom:1px solid var(--color-line);background:var(--color-surface-inverse);color:var(--color-foreground-inverse);">
      <div style="max-width:1400px;margin-inline:auto;padding:clamp(26px,4vw,52px) clamp(16px,4vw,56px);">
        <div style="display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;justify-content:space-between;">
          <div style="display:flex;align-items:baseline;gap:14px;">
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted-inverse);">06</span>
            <span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted-inverse);">Forward pipeline</span>
          </div>
        </div>
        <div data-two="" style="margin-top:16px;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:clamp(20px,3vw,56px);align-items:start;">
          <div>
            <h2 style="margin:0;font-weight:600;font-size:clamp(1.6rem,3.6vw,2.6rem);line-height:1.06;letter-spacing:-0.028em;max-width:22ch;text-wrap:pretty;">Companies that do not have a design job yet.</h2>
            <p style="margin:16px 0 0;font-size:0.98rem;line-height:1.55;color:var(--color-muted-inverse);max-width:52ch;text-wrap:pretty;">Which industries are about to need a designer? Every row carries human evidence, dated. None of it is a prediction, and none of it is scraped from a job board.</p>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px;">
            <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
              <div style="background:var(--color-surface-inverse);padding:14px 16px;">
                <div style="font-family:var(--font-family-mono);font-weight:600;font-size:1.6rem;letter-spacing:-0.02em;">${vm.prospectTotal}</div>
                <div style="margin-top:5px;font-family:var(--font-family-mono);font-size:0.64rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-muted-inverse);">on the pipeline</div>
              </div>
              <div style="background:var(--color-surface-inverse);padding:14px 16px;">
                <div style="font-family:var(--font-family-mono);font-weight:600;font-size:1.6rem;letter-spacing:-0.02em;">${vm.prospectPre}</div>
                <div style="margin-top:5px;font-family:var(--font-family-mono);font-size:0.64rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-muted-inverse);">nothing posted yet</div>
              </div>
              <div style="background:var(--color-surface-inverse);padding:14px 16px;">
                <div style="font-family:var(--font-family-mono);font-weight:600;font-size:1.6rem;letter-spacing:-0.02em;color:var(--color-signal);">${vm.prospectPosted}</div>
                <div style="margin-top:5px;font-family:var(--font-family-mono);font-size:0.64rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-muted-inverse);">have since posted</div>
              </div>
            </div>
            <p style="margin:0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted-inverse);">read ${esc(vm.stamp)} · the whole pipeline, not cut by your titles</p>
          </div>
        </div>
  
        <div data-three="" style="margin-top:28px;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr) minmax(0,1.1fr);gap:1px;background:var(--color-line);border:1px solid var(--color-line);">
  
          <div style="background:var(--color-surface-inverse);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1rem;font-weight:600;letter-spacing:-0.01em;">By industry, weighted by fit</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-muted-inverse);color:var(--color-muted-inverse);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.86rem;line-height:1.5;color:var(--color-muted-inverse);max-width:46ch;">Where should you be talking to people a month before the posting exists?</p>
            <div role="img" aria-label="${escAttr(vm.industryAria)}" style="margin-top:20px;display:flex;flex-direction:column;gap:9px;">${industries}
            </div>
            <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px 16px;font-family:var(--font-family-mono);font-size:0.66rem;color:var(--color-muted-inverse);">
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:var(--color-signal);"></span>fit weighted rows</span>
              <span style="display:inline-flex;align-items:center;gap:6px;"><span aria-hidden="true" style="width:9px;height:9px;background:color-mix(in srgb, var(--color-foreground-inverse) 55%, transparent);"></span>rows on pipeline</span>
              <span>right column is median fit</span>
            </div>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted-inverse);">${esc(vm.readIndustry)}</p>
          </div>
  
          <div style="background:var(--color-surface-inverse);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1rem;font-weight:600;letter-spacing:-0.01em;">Team size</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-muted-inverse);color:var(--color-muted-inverse);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.86rem;line-height:1.5;color:var(--color-muted-inverse);max-width:40ch;">Which companies are funded enough to hire and small enough that no designer exists yet?</p>
            <div role="img" aria-label="${escAttr(vm.teamAria)}" style="margin-top:20px;display:flex;align-items:flex-end;gap:8px;height:172px;">${teamBuckets}
            </div>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.68rem;color:var(--color-muted-inverse);">people on the team, from the company's own site</p>
            <p style="margin:14px 0 0;font-size:0.9rem;line-height:1.5;">${esc(vm.teamReading)}</p>
            <p style="margin:12px 0 0;font-family:var(--font-family-mono);font-size:0.7rem;line-height:1.5;color:var(--color-muted-inverse);">${esc(vm.readTeam)}</p>
          </div>
  
          <div style="background:var(--color-surface-inverse);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column;">
            <div style="display:flex;flex-wrap:wrap;gap:8px 12px;justify-content:space-between;align-items:baseline;">
              <h3 style="margin:0;font-size:1rem;font-weight:600;letter-spacing:-0.01em;">The evidence, ranked</h3>
              <span style="font-family:var(--font-family-mono);font-size:0.62rem;letter-spacing:0.08em;border:1px solid var(--color-muted-inverse);color:var(--color-muted-inverse);padding:2px 6px;white-space:nowrap;">TIER 1</span>
            </div>
            <p style="margin:7px 0 0;font-size:0.86rem;line-height:1.5;color:var(--color-muted-inverse);max-width:44ch;">What is the actual reason a company is on this list?</p>
            <div style="margin-top:18px;display:flex;flex-direction:column;gap:1px;background:var(--color-line);">${signals}
            </div>
            <p style="margin:16px 0 0;font-family:var(--font-family-mono);font-size:0.68rem;line-height:1.5;color:var(--color-muted-inverse);">rows carry more than one signal, so counts do not sum to ${vm.prospectTotal}</p>
            <p style="margin:12px 0 0;font-size:0.86rem;line-height:1.5;color:var(--color-muted-inverse);">Each signal is a sentence a person wrote after reading the company. None of them says a company will hire. They say what was observed, and when.</p>
          </div>
  
        </div>
      </div>
    </section>`;
  }

  // ---- view: method ----
  // Pure. Reproduces the v4 METHOD section, token-mapped, Gate-3 clean.
  // Consumes only vm.method: [{ tag, ink, text }, ...] (6 rows in real data:
  //   measured, computed, absent, pending, held, not claimed).
  // vm.method[].ink already carries SITE tokens (renderVals applied the global
  // token map), so absent/pending inks arrive as var(--color-signal), measured/
  // computed as var(--color-foreground), held/not-claimed as var(--color-muted).
  // This view has NO state-changing controls, so it emits no data-act attributes.
  function render_method(vm) {
    const rows = (vm.method || []).map(function (m) {
      return (
        '<div style="background:var(--color-surface);padding:14px 16px;display:grid;grid-template-columns:104px minmax(0,1fr);gap:14px;align-items:baseline;">' +
          '<span style="font-family:var(--font-family-mono);font-size:0.68rem;letter-spacing:0.06em;text-transform:uppercase;color:' + m.ink + ';">' + m.tag + '</span>' +
          '<span style="font-size:0.88rem;line-height:1.55;color:var(--color-foreground);">' + m.text + '</span>' +
        '</div>'
      );
    }).join('');
  
    return (
      '<section style="border-bottom:1px solid var(--color-line);">' +
        '<div style="max-width:1400px;margin-inline:auto;padding:clamp(24px,3.4vw,40px) clamp(16px,4vw,56px);">' +
          '<div data-two="" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:clamp(20px,3vw,56px);align-items:start;">' +
            '<div>' +
              '<span style="font-family:var(--font-family-mono);font-size:0.76rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--color-muted);">Method</span>' +
              '<h2 style="margin:14px 0 0;font-weight:600;font-size:clamp(1.3rem,2.6vw,1.8rem);line-height:1.1;letter-spacing:-0.022em;max-width:24ch;text-wrap:pretty;">What is measured, what is computed, what is missing.</h2>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:1px;background:var(--color-line);border:1px solid var(--color-line);">' +
              rows +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  window.LEDGER_VIEWS = { render_hero: render_hero, render_shell: render_shell, render_crosscuts: render_crosscuts, render_drag: render_drag, render_issuers: render_issuers, render_archive: render_archive, render_clockview: render_clockview, render_pipeline: render_pipeline, render_method: render_method };
  if (window.LEDGER && window.LEDGER.render) window.LEDGER.render();
})();
