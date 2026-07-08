#!/usr/bin/env node
// Build a self-contained, zero-auth preview of the enriched Obsidian vault
// knowledge graph and write it to `web/public/vault-graph.html` (served at
// `<web-url>/vault-graph.html`). This mirrors what the Memory-tab VaultGraph
// renders from the backend `/memory/graph` endpoint, but bakes the data +
// precomputed d3-force layout into one static file so an operator can look at
// the graph WITHOUT connecting the org's GITHUB_VAULT_TOKEN.
//
// Source graph.json is the Graphify enriched export from the TARCO vault
// (`graphify cluster-only` — Louvain communities named by a local Ollama pass).
// The data is NOT in this repo, so pass its path as arg 1; the resulting HTML
// (which embeds a positioned, minified copy of the graph) IS committed.
//
//   node web/scripts/build-vault-graph-preview.mjs \
//     /Users/artutito/7Ei-MC_TARCO/vault/graphify-out/graph.json vault
//
// Layout is computed here once (headless d3-force) so the runtime page needs
// ZERO external dependencies — no CDN, no d3 at runtime — which keeps it robust
// under any CSP and fully offline-capable.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GRAPH_JSON = process.argv[2] || '/Users/artutito/7Ei-MC_TARCO/vault/graphify-out/graph.json'
const ROOT = (process.argv[3] || 'vault').replace(/^\/+|\/+$/g, '')
const OUT = resolve(__dirname, '../public/vault-graph.html')

const W = 1200, H = 820

// ── Normalize (mirrors backend/src/services/vault-graph.ts parseGraphifyGraph)
function inVault(sf, root) {
  const p = String(sf ?? '').replace(/^\/+/, '')
  if (p.includes('..')) return false
  return !root || p === root || p.startsWith(root + '/')
}
function baseName(p) { const s = String(p ?? ''); return s.slice(s.lastIndexOf('/') + 1) }

function normalize(json, root) {
  const rawNodes = Array.isArray(json?.nodes) ? json.nodes : []
  const rawLinks = Array.isArray(json?.links) ? json.links : (Array.isArray(json?.edges) ? json.edges : [])
  const keep = new Map()
  for (const n of rawNodes) {
    const sf = String(n?.source_file ?? '')
    if (!inVault(sf, root)) continue
    if (/(^|\/)\.obsidian\//.test(sf)) continue
    const isFile = String(n?.source_location ?? 'L1').replace(/^L/i, '') === '1'
    const community = Number.isFinite(n?.community) ? Number(n.community) : undefined
    const rawName = typeof n?.community_name === 'string' ? n.community_name.trim() : ''
    const communityName = rawName && !/^Community\s+\d+$/i.test(rawName) ? rawName : undefined
    keep.set(String(n.id), {
      id: String(n.id),
      label: String(n.label ?? baseName(sf) ?? n.id),
      kind: isFile ? 'note' : 'heading',
      path: isFile ? sf.replace(/^\/+/, '') : undefined,
      community, communityName, degree: 0,
    })
  }
  const edges = []
  let links = 0
  for (const l of rawLinks) {
    const s = String(l?.source ?? ''), t = String(l?.target ?? '')
    if (!keep.has(s) || !keep.has(t) || s === t) continue
    const relation = l?.relation === 'contains' ? 'contains' : l?.relation === 'references' ? 'references' : 'link'
    edges.push({ source: s, target: t, relation, weight: Number(l?.weight) || 1 })
    if (relation !== 'contains') links++
  }
  const nodes = [...keep.values()]
  const deg = new Map()
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  for (const n of nodes) n.degree = deg.get(n.id) ?? 0
  const communities = new Set(nodes.map(n => n.communityName).filter(Boolean)).size
  return { nodes, edges, notes: nodes.filter(n => n.kind === 'note').length, links, communities }
}

// ── Colorblind-safe assignment: Okabe–Ito ramp, largest communities get the
//    most distinct hues; color is ALWAYS paired with the text label + legend.
const CVD = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442', '#664D9E', '#117733', '#88CCEE', '#AA4499', '#DDCC77']
function radiusOf(n) { return n.kind === 'tag' ? 3.5 : 4 + Math.min(11, Math.sqrt(n.degree) * 2.2) }

// ── Headless d3-force layout (same forces as the app, cooled to static) ──────
function computeLayout(nodes, edges) {
  const n = nodes.length || 1
  const pnodes = nodes.map((nd, i) => {
    const a = (i / n) * Math.PI * 2, r = 40 + (i % 40) * 6
    return { ...nd, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r }
  })
  const byId = new Map(pnodes.map(p => [p.id, p]))
  const links = edges.filter(e => byId.has(e.source) && byId.has(e.target))
    .map(e => ({ source: byId.get(e.source), target: byId.get(e.target), relation: e.relation }))
  const sim = forceSimulation(pnodes)
    .force('charge', forceManyBody().strength(-150).distanceMax(400))
    .force('link', forceLink(links).id(d => d.id).distance(46).strength(0.35))
    .force('center', forceCenter(W / 2, H / 2))
    .force('collide', forceCollide().radius(d => radiusOf(d) + 2))
    .force('x', forceX(W / 2).strength(0.035))
    .force('y', forceY(H / 2).strength(0.035))
    .stop()
  const ticks = Math.min(600, Math.max(200, Math.round(Math.sqrt(n) * 26)))
  for (let i = 0; i < ticks; i++) sim.tick()
  return pnodes
}

// ── Build ────────────────────────────────────────────────────────────────────
const json = JSON.parse(readFileSync(GRAPH_JSON, 'utf8'))
const g = normalize(json, ROOT)
const pnodes = computeLayout(g.nodes, g.edges)

// community → { name, count, color } ; rank by size for stable, meaningful hues
const byComm = new Map()
for (const n of pnodes) {
  const key = n.communityName ?? (n.community != null ? `Community ${n.community}` : 'Unclustered')
  const e = byComm.get(key) ?? { name: key, count: 0 }
  e.count++; byComm.set(key, e)
}
const ranked = [...byComm.values()].sort((a, b) => b.count - a.count)
ranked.forEach((c, i) => { c.color = CVD[i % CVD.length] })
const colorOf = new Map(ranked.map(c => [c.name, c.color]))

// round coords to shrink payload; keep only what the runtime needs
const round = (v) => Math.round(v * 10) / 10
const outNodes = pnodes.map(n => ({
  i: n.id, l: n.label, x: round(n.x), y: round(n.y), r: round(radiusOf(n)),
  c: colorOf.get(n.communityName ?? (n.community != null ? `Community ${n.community}` : 'Unclustered')),
  g: n.communityName ?? (n.community != null ? `Community ${n.community}` : 'Unclustered'),
  d: n.degree, p: n.path || '',
}))
const idIdx = new Map(pnodes.map((n, i) => [n.id, i]))
const outEdges = g.edges
  .filter(e => idIdx.has(e.source) && idIdx.has(e.target))
  .map(e => ({ s: idIdx.get(e.source), t: idIdx.get(e.target), r: e.relation }))

const bbox = pnodes.reduce((b, n) => ({
  minX: Math.min(b.minX, n.x), minY: Math.min(b.minY, n.y),
  maxX: Math.max(b.maxX, n.x), maxY: Math.max(b.maxY, n.y),
}), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

const payload = {
  meta: {
    notes: g.notes, communities: g.communities, links: g.links,
    nodes: outNodes.length, edges: outEdges.length,
    commit: String(json?.built_at_commit ?? '').slice(0, 10) || null,
  },
  legend: ranked.map(c => ({ name: c.name, count: c.count, color: c.color })),
  nodes: outNodes, edges: outEdges, bbox: bbox,
}

const DATA = JSON.stringify(payload)
const html = renderHtml(DATA, payload.meta)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`✓ wrote ${OUT} (${kb} KB) — ${payload.meta.nodes} nodes, ${payload.meta.edges} edges, ${payload.meta.communities} communities`)

function renderHtml(data, meta) {
  // NB: the page below is intentionally dependency-free. All layout is baked in.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>7Ei Vault Knowledge Graph — preview</title>
<style>
  :root{
    --bg:#0b0e14; --panel:#131824; --panel2:#1b2233; --line:#273043;
    --text:#e6e9ef; --muted:#8b93a7; --accent:#56B4E9;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;
    padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
  header h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.2px}
  header .sub{color:var(--muted);font-size:12.5px}
  header .badge{margin-left:auto;font-size:11px;color:var(--muted);
    border:1px solid var(--line);border-radius:999px;padding:3px 10px}
  .wrap{display:flex;height:calc(100% - 53px);min-height:0}
  aside{width:270px;flex:none;border-right:1px solid var(--line);background:var(--panel);
    overflow:auto;padding:12px 14px}
  aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);
    margin:14px 0 8px}
  .search{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;
    background:var(--panel2);color:var(--text);font-size:13px}
  .search::placeholder{color:var(--muted)}
  .legend{list-style:none;margin:0;padding:0}
  .legend li{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;
    cursor:pointer;font-size:12.5px}
  .legend li:hover{background:var(--panel2)}
  .legend li.dim{opacity:.4}
  .sw{width:11px;height:11px;border-radius:3px;flex:none}
  .legend .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .legend .ct{color:var(--muted);font-variant-numeric:tabular-nums}
  .more{margin-top:8px;font-size:12px;color:var(--accent);cursor:pointer;background:none;
    border:none;padding:4px}
  main{flex:1;min-width:0;position:relative;overflow:hidden}
  svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none}
  svg.drag{cursor:grabbing}
  .edge{stroke:#2b3448;stroke-width:1}
  .edge.contains{stroke:#222a3a}
  .node{cursor:pointer}
  .node text{font-size:9px;fill:var(--text);pointer-events:none;paint-order:stroke;
    stroke:var(--bg);stroke-width:2.5px;stroke-linejoin:round}
  .node.faded{opacity:.12}
  .edge.faded{opacity:.05}
  #tip{position:absolute;pointer-events:none;background:var(--panel2);border:1px solid var(--line);
    border-radius:8px;padding:8px 10px;font-size:12.5px;max-width:260px;opacity:0;
    transition:opacity .08s;box-shadow:0 6px 20px rgba(0,0,0,.4);z-index:5}
  #tip .t{font-weight:650;margin-bottom:2px}
  #tip .m{color:var(--muted);font-size:11.5px}
  .ctrls{position:absolute;right:12px;bottom:12px;display:flex;gap:6px}
  .ctrls button{width:30px;height:30px;border:1px solid var(--line);background:var(--panel);
    color:var(--text);border-radius:8px;font-size:15px;cursor:pointer}
  .ctrls button:hover{background:var(--panel2)}
  .foot{color:var(--muted);font-size:11px;margin-top:16px;line-height:1.6}
  a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>7Ei Vault — Knowledge Graph</h1>
  <span class="sub" id="stats"></span>
  <span class="badge">read-only preview · no login</span>
</header>
<div class="wrap">
  <aside>
    <input id="q" class="search" placeholder="Search notes…" autocomplete="off">
    <h2>Semantic communities</h2>
    <ul class="legend" id="legend"></ul>
    <button class="more" id="more"></button>
    <div class="foot">
      Nodes are vault notes; color groups them into Louvain <b>communities</b>
      named by a local LLM pass (Graphify). Size = link degree. Colors use the
      Okabe–Ito colorblind-safe ramp and repeat across many communities — the
      label is always the source of truth. Drag to pan, scroll to zoom, click a
      node to isolate its neighborhood.
    </div>
  </aside>
  <main>
    <svg id="svg"><g id="scene">
      <g id="edges"></g><g id="nodes"></g>
    </g></svg>
    <div id="tip"></div>
    <div class="ctrls">
      <button id="zin" title="Zoom in">+</button>
      <button id="zout" title="Zoom out">−</button>
      <button id="zfit" title="Fit">⤢</button>
    </div>
  </main>
</div>
<script id="data" type="application/json">${data}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById('data').textContent);
  var NS='http://www.w3.org/2000/svg';
  var svg=document.getElementById('svg'), scene=document.getElementById('scene');
  var gEdges=document.getElementById('edges'), gNodes=document.getElementById('nodes');
  var tip=document.getElementById('tip');
  document.getElementById('stats').textContent =
    D.meta.nodes+' nodes ('+D.meta.notes+' notes) · '+D.meta.communities+' communities · '
    +D.meta.edges+' links'+ (D.meta.commit ? ' · '+D.meta.commit : '');

  // adjacency for neighbor isolation
  var adj = D.nodes.map(function(){return [];});
  D.edges.forEach(function(e){ adj[e.s].push(e.t); adj[e.t].push(e.s); });

  // edges
  var edgeEls = D.edges.map(function(e){
    var a=D.nodes[e.s], b=D.nodes[e.t];
    var ln=document.createElementNS(NS,'line');
    ln.setAttribute('x1',a.x); ln.setAttribute('y1',a.y);
    ln.setAttribute('x2',b.x); ln.setAttribute('y2',b.y);
    ln.setAttribute('class','edge'+(e.r==='contains'?' contains':''));
    gEdges.appendChild(ln); return ln;
  });
  // nodes
  var nodeEls = D.nodes.map(function(n,i){
    var grp=document.createElementNS(NS,'g'); grp.setAttribute('class','node');
    grp.setAttribute('transform','translate('+n.x+','+n.y+')');
    var c=document.createElementNS(NS,'circle');
    c.setAttribute('r',n.r); c.setAttribute('fill',n.c);
    c.setAttribute('stroke','#0b0e14'); c.setAttribute('stroke-width','1');
    grp.appendChild(c);
    if(n.d>=4){ var t=document.createElementNS(NS,'text');
      t.setAttribute('x',n.r+2); t.setAttribute('y',3); t.textContent=n.l; grp.appendChild(t); }
    grp.addEventListener('mouseenter',function(ev){ showTip(ev,n); });
    grp.addEventListener('mousemove',function(ev){ moveTip(ev); });
    grp.addEventListener('mouseleave',function(){ tip.style.opacity=0; });
    grp.addEventListener('click',function(ev){ ev.stopPropagation(); isolate(i); });
    gNodes.appendChild(grp); return grp;
  });

  function showTip(ev,n){
    tip.innerHTML='<div class="t"></div><div class="m"></div><div class="m"></div>';
    tip.querySelector('.t').textContent=n.l;
    var ms=tip.querySelectorAll('.m');
    ms[0].textContent=n.g;
    ms[1].textContent=(n.p||'')+' · '+n.d+' links';
    tip.style.opacity=1; moveTip(ev);
  }
  function moveTip(ev){
    var r=svg.getBoundingClientRect();
    var x=ev.clientX-r.left+14, y=ev.clientY-r.top+14;
    if(x>r.width-270) x=ev.clientX-r.left-260;
    tip.style.left=x+'px'; tip.style.top=y+'px';
  }

  // isolate neighborhood on click; click background to reset
  var isolated=null;
  function isolate(i){
    if(isolated===i){ resetFocus(); return; }
    isolated=i;
    var keep={}; keep[i]=1; adj[i].forEach(function(j){keep[j]=1;});
    nodeEls.forEach(function(el,j){ el.classList.toggle('faded', !keep[j]); });
    edgeEls.forEach(function(el,k){ var e=D.edges[k];
      el.classList.toggle('faded', !(e.s===i||e.t===i)); });
  }
  function resetFocus(){ isolated=null;
    nodeEls.forEach(function(el){el.classList.remove('faded');});
    edgeEls.forEach(function(el){el.classList.remove('faded');}); }
  svg.addEventListener('click',resetFocus);

  // search
  var q=document.getElementById('q');
  q.addEventListener('input',function(){
    var v=q.value.trim().toLowerCase();
    if(!v){ resetFocus(); return; }
    isolated=null;
    nodeEls.forEach(function(el,j){
      el.classList.toggle('faded', D.nodes[j].l.toLowerCase().indexOf(v)<0); });
    edgeEls.forEach(function(el){ el.classList.add('faded'); });
  });

  // legend (top 14 distinctly colored, expandable)
  var legend=document.getElementById('legend'), more=document.getElementById('more');
  var expanded=false; var TOP=14;
  function renderLegend(){
    legend.innerHTML='';
    var list=expanded?D.legend:D.legend.slice(0,TOP);
    list.forEach(function(c){
      var li=document.createElement('li');
      li.innerHTML='<span class="sw"></span><span class="nm"></span><span class="ct"></span>';
      li.querySelector('.sw').style.background=c.color;
      li.querySelector('.nm').textContent=c.name;
      li.querySelector('.ct').textContent=c.count;
      li.addEventListener('click',function(){ filterCommunity(c.name); });
      legend.appendChild(li);
    });
    more.textContent = expanded ? 'Show fewer' : ('Show all '+D.legend.length+' communities');
  }
  more.addEventListener('click',function(){ expanded=!expanded; renderLegend(); });
  function filterCommunity(name){
    isolated=null; q.value='';
    nodeEls.forEach(function(el,j){ el.classList.toggle('faded', D.nodes[j].g!==name); });
    edgeEls.forEach(function(el,k){ var e=D.edges[k];
      el.classList.toggle('faded', !(D.nodes[e.s].g===name && D.nodes[e.t].g===name)); });
  }
  renderLegend();

  // pan + zoom (vanilla; transform on scene <g>)
  var vb=D.bbox, pad=60;
  var tx=0,ty=0,scale=1;
  function apply(){ scene.setAttribute('transform','translate('+tx+','+ty+') scale('+scale+')'); }
  function fit(){
    var w=svg.clientWidth, h=svg.clientHeight;
    var gw=(vb.maxX-vb.minX)+pad*2, gh=(vb.maxY-vb.minY)+pad*2;
    scale=Math.min(w/gw, h/gh);
    tx=(w-(vb.minX+vb.maxX)*scale)/2; ty=(h-(vb.minY+vb.maxY)*scale)/2; apply();
  }
  var dragging=false, px=0, py=0;
  svg.addEventListener('pointerdown',function(e){ dragging=true; px=e.clientX; py=e.clientY;
    svg.classList.add('drag'); svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove',function(e){ if(!dragging)return;
    tx+=e.clientX-px; ty+=e.clientY-py; px=e.clientX; py=e.clientY; apply(); });
  svg.addEventListener('pointerup',function(e){ dragging=false; svg.classList.remove('drag'); });
  svg.addEventListener('wheel',function(e){ e.preventDefault();
    var r=svg.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
    var f=Math.exp(-e.deltaY*0.0015), ns=Math.max(0.1,Math.min(8,scale*f));
    tx=mx-(mx-tx)*(ns/scale); ty=my-(my-ty)*(ns/scale); scale=ns; apply();
  },{passive:false});
  document.getElementById('zin').onclick=function(){ zoomBy(1.3); };
  document.getElementById('zout').onclick=function(){ zoomBy(1/1.3); };
  document.getElementById('zfit').onclick=fit;
  function zoomBy(f){ var w=svg.clientWidth/2,h=svg.clientHeight/2,ns=Math.max(0.1,Math.min(8,scale*f));
    tx=w-(w-tx)*(ns/scale); ty=h-(h-ty)*(ns/scale); scale=ns; apply(); }
  fit(); window.addEventListener('resize',fit);
})();
</script>
</body>
</html>`
}
