const $ = (id) => document.getElementById(id);

// ============================================
// OPTIONAL: Firebase (public submissions/votes)
// ============================================
// If you want public persistence, add Firebase scripts in index.html BEFORE app.js:
// <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
//
// Then paste your config here and set ENABLE_FIREBASE = true.
const ENABLE_FIREBASE = false;
const FIREBASE_CONFIG = {
  // apiKey: "",
  // authDomain: "",
  // projectId: "",
  // storageBucket: "",
  // messagingSenderId: "",
  // appId: ""
};
let db = null;

// ------------------------------
// Data (Used Today / Future Lab)
// ------------------------------
const NOW_TECH = [
  {
    id: "air",
    title: "Air Cooling",
    sub: "Fans + cold aisle / hot aisle. Legacy baseline.",
    tags: ["cheap", "simple", "fails at high density"],
    body: `
      <p><b>How it works:</b> Move cool air through racks; exhaust hot air out. Room-level CRAC/CRAH units do the heavy lifting.</p>
      <p><b>Why it breaks for AI:</b> AI racks can exceed 80–200kW. Air has low heat capacity + convection coefficient, so you hit a heat-flux wall.</p>
      <ul>
        <li>✅ Lowest complexity</li>
        <li>❌ Poor for >30–50kW racks</li>
        <li>❌ Hotspots become brutal</li>
      </ul>
    `
  },
  {
    id: "dtc",
    title: "Direct-to-Chip Liquid",
    sub: "Cold plates on GPUs/CPUs + facility water loop.",
    tags: ["mainstream for AI", "efficient", "serviceable"],
    body: `
      <p><b>How it works:</b> Liquid cold plates pull heat from GPU/CPU; coolant loops carry heat to heat exchangers.</p>
      <p><b>Why it wins:</b> Liquids carry heat far better than air, enabling higher rack densities while keeping temps stable.</p>
      <ul>
        <li>✅ Most common modern approach for AI clusters</li>
        <li>✅ Scales to high kW/rack</li>
        <li>❌ Still limited by hotspots + interface resistance</li>
      </ul>
    `
  },
  {
    id: "imm",
    title: "Immersion Cooling",
    sub: "Servers submerged in dielectric fluid (single/two-phase).",
    tags: ["high density", "hard ops", "very effective"],
    body: `
      <p><b>How it works:</b> Entire boards sit in non-conductive fluid; heat transfers directly into the fluid.</p>
      <p><b>Where it shines:</b> Extreme power density racks where air is impossible.</p>
      <ul>
        <li>✅ Excellent heat transfer</li>
        <li>✅ Can unlock very high rack densities</li>
        <li>❌ Maintenance + fluids + ecosystem friction</li>
      </ul>
    `
  },
  {
    id: "rear",
    title: "Rear-Door Heat Exchanger",
    sub: "Cooling at the rack door to catch hot exhaust air.",
    tags: ["transitional", "rack-level", "hybrid"],
    body: `
      <p><b>How it works:</b> Hot exhaust air passes through a liquid-cooled rear door coil before it re-enters the room.</p>
      <p><b>Use case:</b> Bridge solution for existing facilities upgrading density without full liquid retrofit.</p>
      <ul>
        <li>✅ Less invasive upgrade</li>
        <li>❌ Not as good as direct-to-chip for extreme AI</li>
      </ul>
    `
  },
  {
    id: "free",
    title: "Free Cooling",
    sub: "Use outside air/conditions in cold climates.",
    tags: ["climate dependent", "efficient", "location matters"],
    body: `
      <p><b>How it works:</b> When ambient is cold enough, you can reject heat without heavy mechanical chilling.</p>
      <p><b>Constraint:</b> You can’t free-cool in hot/humid regions most of the year.</p>
      <ul>
        <li>✅ Very efficient in cold climates</li>
        <li>❌ Geography-limited</li>
      </ul>
    `
  }
];

const FUTURE_IDEAS = [
  {
    id: "pcm",
    title: "PCM Thermal Battery",
    sub: "Store heat during spikes; dump it later. Peak-shaving.",
    hint: "Watch heat spikes get absorbed, then released slowly."
  },
  {
    id: "sched",
    title: "Thermal-Aware Scheduling",
    sub: "Move workloads across racks to avoid hotspots.",
    hint: "Jobs migrate toward “cool” regions like a load balancer for heat."
  },
  {
    id: "micro",
    title: "Microfluidic ‘Veins’",
    sub: "Cooling channels inside/near the die for hotspots.",
    hint: "Hotspot dots shrink as micro-channels kick in."
  },
  {
    id: "mag",
    title: "Magnetocaloric Cooling",
    sub: "Solid-state cooling without compressors.",
    hint: "Magnetic cycles pump heat out with a rhythmic pulse."
  },
  {
    id: "teg",
    title: "Thermoelectric Recovery",
    sub: "Convert some waste heat into small power for sensors/fans.",
    hint: "Heat becomes a tiny “recovered power” bar."
  }
];

// ------------------------------
// Simulator model (intuition)
// ------------------------------
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function pct(n){ return `${clamp(n, 0, 100).toFixed(0)}%`; }

function coolingProfile(cool){
  // rough “capabilities” (intuition knobs)
  // fluxCap: tolerance for power density
  // infraCap: how much kW/rack is “comfortable”
  // waterCost: relative complexity/water
  const map = {
    air: { fluxCap: 35, infraCap: 35, waterCost: 15, name:"Air" },
    dtc: { fluxCap: 70, infraCap: 120, waterCost: 55, name:"Direct-to-chip" },
    imm: { fluxCap: 85, infraCap: 180, waterCost: 75, name:"Immersion" },
    pcm: { fluxCap: 60, infraCap: 90,  waterCost: 40, name:"PCM Buffer" },
    mag: { fluxCap: 65, infraCap: 100, waterCost: 35, name:"Magnetocaloric" }
  };
  return map[cool] || map.air;
}

function computeSim({gpuW, gpusPer, srvPer, ovhPct, cool}){
  const totalGpu = gpuW * gpusPer * srvPer;
  const overhead = totalGpu * (ovhPct / 100);
  const rackW = totalGpu + overhead;
  const rackKw = rackW / 1000;

  // Heat flux “stress” index: scale with GPU power density proxy
  // We'll treat >1000W GPUs + many per server as hotspotty
  const fluxStress = clamp(
    (gpuW / 1500) * 60 + (gpusPer / 16) * 40,
    0, 100
  );

  const prof = coolingProfile(cool);

  // Hotspot risk increases if fluxStress exceeds capability, plus extra if rack density is high
  const fluxOver = clamp((fluxStress - prof.fluxCap) * 1.4, 0, 100);
  const densityOver = clamp(((rackKw - prof.infraCap) / Math.max(1, prof.infraCap)) * 120, 0, 100);

  const hotspot = clamp(20 + fluxOver * 0.75 + densityOver * 0.55, 0, 100);

  // Infra difficulty: combines density pressure + cooling complexity
  const infra = clamp(densityOver * 0.9 + prof.waterCost * 0.55 + (fluxOver * 0.35), 0, 100);

  // Water/complexity: narrative metric
  const water = clamp(prof.waterCost + clamp((rackKw / 200) * 30, 0, 30), 0, 100);

  return { rackKw, fluxStress, hotspot, infra, water, prof };
}

// ------------------------------
// UI helpers
// ------------------------------
function setFill(id, value01){
  const el = $(id);
  if (!el) return;
  el.style.width = pct(value01 * 100);
}

function riskLabel(x){
  if (x < 30) return "LOW";
  if (x < 55) return "MED";
  if (x < 80) return "HIGH";
  return "CRITICAL";
}

function statusFrom(hotspot, infra){
  const s = Math.max(hotspot, infra);
  if (s < 35) return { txt:"THERMAL: NOMINAL", color:"rgba(0,255,170,.85)" };
  if (s < 60) return { txt:"THERMAL: WATCH", color:"rgba(255,220,80,.85)" };
  if (s < 80) return { txt:"THERMAL: HOT", color:"rgba(255,140,60,.85)" };
  return { txt:"THERMAL: LIMIT", color:"rgba(255,70,70,.9)" };
}

// ------------------------------
// Rack visualization
// ------------------------------
function buildRackCells(){
  const grid = $("rackRows");
  if (!grid) return;
  grid.innerHTML = "";
  for (let i=0;i<60;i++){
    const d = document.createElement("div");
    d.className = "cell";
    grid.appendChild(d);
  }
}

function paintRack(heat01){
  const grid = $("rackRows");
  if (!grid) return;
  const cells = [...grid.querySelectorAll(".cell")];
  for (let i=0;i<cells.length;i++){
    // pseudo heat map variation
    const jitter = (Math.sin(i*1.7 + heat01*10) + 1) * 0.5;
    const h = clamp(heat01*0.85 + jitter*0.25, 0, 1);

    // map to cold->hot brightness
    const a = 0.06 + h*0.35;
    cells[i].style.background = `rgba(0,140,255,${a})`;
    cells[i].style.borderColor = `rgba(255,255,255,${0.08 + h*0.10})`;
  }

  const glow = $("rackGlow");
  if (glow){
    glow.style.opacity = String(0.6 + heat01*0.6);
    glow.style.filter = `blur(${10 + heat01*8}px)`;
  }
}

// ------------------------------
// Drawer (card details)
// ------------------------------
function openDrawer(card){
  $("dTitle").textContent = card.title;
  $("dSub").textContent = card.sub;
  $("dBody").innerHTML = card.body;
  $("drawer").classList.add("show");
  $("drawer").setAttribute("aria-hidden", "false");
}
function closeDrawer(){
  $("drawer").classList.remove("show");
  $("drawer").setAttribute("aria-hidden", "true");
}

// ------------------------------
// Future Lab canvas mini-sims
// ------------------------------
const lab = {
  idea: FUTURE_IDEAS[0],
  load: 65,
  running: false,
  t: 0
};

function labDraw(){
  const c = $("labCanvas");
  if (!c) return;
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;

  // clear
  ctx.clearRect(0,0,W,H);

  // background grid
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = "rgba(255,255,255,.25)";
  ctx.lineWidth = 1;
  for (let x=40;x<W;x+=60){
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
  }
  for (let y=30;y<H;y+=50){
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // “rack” area
  const rackX=60, rackY=70, rackW=520, rackH=280;
  ctx.strokeStyle = "rgba(0,180,255,.35)";
  ctx.strokeRect(rackX, rackY, rackW, rackH);

  // heat baseline
  const heat = clamp(lab.load/100, 0, 1);
  const pulse = (Math.sin(lab.t*2.0)+1)*0.5;

  // draw “heat cells”
  const cols=16, rows=8;
  const cw = rackW/cols, ch=rackH/rows;

  for (let r=0;r<rows;r++){
    for (let col=0;col<cols;col++){
      const base = heat;
      const hotspot = Math.exp(-((col-11)**2+(r-3)**2)/12) * 0.55; // a hotspot region
      let h = clamp(base*0.7 + hotspot, 0, 1);

      // modify by idea
      if (lab.idea.id === "pcm"){
        // PCM buffers peaks: reduce sharpness when pulse is high
        h = clamp(h - (pulse*0.18), 0, 1);
      } else if (lab.idea.id === "sched"){
        // scheduling spreads load: hotspot spreads out
        const spread = Math.exp(-((col-9)**2+(r-4)**2)/22) * 0.35;
        h = clamp(base*0.65 + spread, 0, 1);
      } else if (lab.idea.id === "micro"){
        // microfluidic targets hotspot region
        const coolSpot = Math.exp(-((col-11)**2+(r-3)**2)/10) * 0.35;
        h = clamp(h - coolSpot, 0, 1);
      } else if (lab.idea.id === "mag"){
        // periodic extraction
        h = clamp(h - (0.12 + 0.10*pulse), 0, 1);
      } else if (lab.idea.id === "teg"){
        // doesn’t cool much; adds recovery meter
        h = clamp(h - 0.05, 0, 1);
      }

      const a = 0.06 + h*0.45;
      ctx.fillStyle = `rgba(0,140,255,${a})`;
      ctx.fillRect(rackX + col*cw + 3, rackY + r*ch + 3, cw - 6, ch - 6);
    }
  }

  // side readouts
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.font = "900 18px ui-monospace, monospace";
  ctx.fillText("LAB: " + lab.idea.title.toUpperCase(), 60, 40);

  ctx.fillStyle = "rgba(255,255,255,.65)";
  ctx.font = "700 12px ui-monospace, monospace";
  ctx.fillText("LOAD", 610, 110);
  ctx.fillText("EFFECT", 610, 190);

  // meters
  const meterX=610, meterW=240, meterH=12;

  // load meter
  ctx.strokeStyle = "rgba(255,255,255,.20)";
  ctx.strokeRect(meterX, 120, meterW, meterH);
  ctx.fillStyle = "rgba(0,180,255,.75)";
  ctx.fillRect(meterX, 120, meterW*(lab.load/100), meterH);

  // effect meter (just for storytelling)
  const eff = (() => {
    if (lab.idea.id === "pcm") return 0.55 + 0.25*pulse;
    if (lab.idea.id === "sched") return 0.60;
    if (lab.idea.id === "micro") return 0.70;
    if (lab.idea.id === "mag") return 0.58 + 0.22*pulse;
    if (lab.idea.id === "teg") return 0.18 + 0.15*heat;
    return 0.5;
  })();
  ctx.strokeRect(meterX, 200, meterW, meterH);
  ctx.fillStyle = "rgba(120,220,255,.75)";
  ctx.fillRect(meterX, 200, meterW*eff, meterH);

  if (lab.idea.id === "teg"){
    ctx.fillStyle = "rgba(255,255,255,.65)";
    ctx.fillText("RECOVERED POWER", 610, 255);
    ctx.strokeRect(meterX, 265, meterW, meterH);
    const rec = clamp(0.06 + heat*0.22, 0, 1);
    ctx.fillStyle = "rgba(0,255,170,.55)";
    ctx.fillRect(meterX, 265, meterW*rec, meterH);
  }

  // caption
  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = "800 12px ui-monospace, monospace";
  ctx.fillText(lab.idea.hint, 60, 382);
}

function labTick(){
  if (!lab.running) return;
  lab.t += 0.016;
  labDraw();
  requestAnimationFrame(labTick);
}

// ------------------------------
// Idea Arena (local-first)
// ------------------------------
function looksLikeSpam(text){
  const t = (text || "").toLowerCase();
  const links = (t.match(/https?:\/\/|www\./g) || []).length;
  if (links >= 2) return true;
  if (/(.)\1\1\1\1/.test(t)) return true;

  const spam = ["crypto","forex","airdrop","telegram","whatsapp","casino","free money","buy now","click here"];
  if (spam.some(w => t.includes(w))) return true;

  const vulgar = ["fuck","shit","bitch","asshole","cunt","nigger","faggot","retard"];
  if (vulgar.some(w => t.includes(w))) return true;

  return false;
}

function nowISO(){
  const d = new Date();
  const pad=(n)=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let ideas = [];

function loadIdeas(){
  const raw = localStorage.getItem("heatstack_ideas");
  ideas = raw ? JSON.parse(raw) : [
    { id: cryptoId(), text:"PCM walls as thermal batteries to shave peak training heat loads.", name:"anon", ts: nowISO(), up: 7 },
    { id: cryptoId(), text:"Thermal-aware job scheduler that migrates workloads based on live hotspot maps.", name:"anon", ts: nowISO(), up: 5 }
  ];
}
function saveIdeas(){
  localStorage.setItem("heatstack_ideas", JSON.stringify(ideas));
}

function cryptoId(){
  return "i_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function renderIdeas(sort="hot"){
  const box = $("ideas");
  if (!box) return;

  let list = [...ideas];
  if (sort === "new") list.sort((a,b)=> (b._t || 0) - (a._t || 0));
  if (sort === "top") list.sort((a,b)=> (b.up||0) - (a.up||0));
  if (sort === "hot") list.sort((a,b)=> ((b.up||0) * 2) - ((a.up||0) * 2));

  box.innerHTML = "";
  list.forEach(item=>{
    const el = document.createElement("div");
    el.className = "idea";
    el.innerHTML = `
      <div class="ideaTop">
        <div>
          <div class="ideaTitle">${escapeHtml(item.name || "anon")}</div>
          <div class="ideaMeta mono">${escapeHtml(item.ts || "")} • <b>${item.up||0}</b> upvotes</div>
        </div>
      </div>
      <div class="ideaText">${escapeHtml(item.text)}</div>
      <div class="ideaBtns">
        <button class="btn ghost mono" data-up="${item.id}">▲ Upvote</button>
        <button class="btn ghost mono" data-copy="${item.id}">Copy</button>
      </div>
    `;
    box.appendChild(el);
  });

  box.querySelectorAll("[data-up]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.getAttribute("data-up");
      const it = ideas.find(x=>x.id===id);
      if (!it) return;
      it.up = (it.up||0) + 1;
      saveIdeas();
      renderIdeas(currentSort);
    });
  });

  box.querySelectorAll("[data-copy]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const id = btn.getAttribute("data-copy");
      const it = ideas.find(x=>x.id===id);
      if (!it) return;
      await navigator.clipboard.writeText(it.text);
      $("ideaMsg").textContent = "Copied ✅";
      setTimeout(()=>{ $("ideaMsg").textContent = ""; }, 900);
    });
  });
}

function escapeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

let currentSort = "hot";

async function submitIdea(){
  const msg = $("ideaMsg");
  const text = ($("ideaText")?.value || "").trim();
  const name = ($("ideaName")?.value || "").trim();

  if (!text){
    msg.textContent = "Type an idea first 🙂";
    return;
  }
  if (text.length > 900){
    msg.textContent = "Keep it under 900 chars.";
    return;
  }
  if (looksLikeSpam(text)){
    msg.textContent = "That got eaten by the spam filter 🕳️";
    $("ideaText").value = "";
    return;
  }

  // Local-first
  const item = { id: cryptoId(), text, name: name || "anon", ts: nowISO(), up: 0, _t: Date.now() };
  ideas.unshift(item);
  saveIdeas();
  $("ideaText").value = "";
  $("ideaName").value = "";
  msg.textContent = "Submitted ✅";
  setTimeout(()=>{ msg.textContent = ""; }, 1200);

  renderIdeas(currentSort);

  // Optional: Firebase
  if (ENABLE_FIREBASE && db){
    try{
      await db.collection("ideas").add({
        text, name: name || null,
        up: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      $("arenaMode").textContent = "PUBLIC";
    } catch(e){
      console.warn(e);
      $("arenaMode").textContent = "LOCAL";
    }
  }
}

// ------------------------------
// Rendering / init
// ------------------------------
let simState = { cool:"air" };

function renderSim(){
  const gpuW = Number($("gpuW").value);
  const gpusPer = Number($("gpusPer").value);
  const srvPer = Number($("srvPer").value);
  const ovhPct = Number($("ovh").value);

  $("gpuWLabel").textContent = `${gpuW} W`;
  $("gpusPerLabel").textContent = `${gpusPer}`;
  $("srvPerLabel").textContent = `${srvPer}`;
  $("ovhLabel").textContent = `${ovhPct}%`;

  const out = computeSim({gpuW, gpusPer, srvPer, ovhPct, cool: simState.cool});

  // Outputs
  $("oRackKw").textContent = `${out.rackKw.toFixed(1)} kW`;
  $("oFlux").textContent = `${riskLabel(out.fluxStress)} (${out.fluxStress.toFixed(0)})`;
  $("oHot").textContent  = `${riskLabel(out.hotspot)} (${out.hotspot.toFixed(0)})`;
  $("oDiff").textContent = `${riskLabel(out.infra)} (${out.infra.toFixed(0)})`;

  setFill("bRack", clamp(out.rackKw/200, 0, 1));
  setFill("bFlux", out.fluxStress/100);
  setFill("bHot",  out.hotspot/100);
  setFill("bDiff", out.infra/100);

  // HUD mirror
  $("rRackPower").textContent = `${out.rackKw.toFixed(1)} kW`;
  $("rHotspot").textContent = `${riskLabel(out.hotspot)} (${out.hotspot.toFixed(0)})`;
  $("rDifficulty").textContent = `${riskLabel(out.infra)} (${out.infra.toFixed(0)})`;
  $("rWater").textContent = `${riskLabel(out.water)} (${out.water.toFixed(0)})`;

  // Status
  const st = statusFrom(out.hotspot, out.infra);
  $("statusText").textContent = st.txt;
  document.querySelector(".dot").style.background = st.color;

  // Callout
  const coolName = out.prof.name;
  const msg = (() => {
    if (out.rackKw > 120 && simState.cool === "air") return "Air cooling is collapsing here. Try Direct-to-chip or Immersion.";
    if (out.fluxStress > 70 && simState.cool === "dtc") return "Even liquid hits hotspots. Microfluidics or better TIM becomes the game.";
    if (simState.cool === "pcm") return "PCM buffers spikes, but you still must dump heat later (thermal battery).";
    if (simState.cool === "mag") return "Magnetocaloric is promising, but still rare in real deployments.";
    return `${coolName}: watch hotspot + infra pressure as you push density.`;
  })();
  $("simCallout").textContent = msg;

  // Rack heat map intensity
  const heat01 = clamp((out.hotspot*0.65 + out.infra*0.35)/100, 0, 1);
  paintRack(heat01);
}

function initNowCards(){
  const box = $("nowCards");
  box.innerHTML = "";

  // include extra current method card for context
  const list = [
    ...NOW_TECH,
    {
      id:"seawater",
      title:"Seawater Heat Rejection",
      sub:"Use nearby seawater as a heat sink via exchangers.",
      tags:["site-specific", "efficient", "needs coast"],
      body:`<p><b>How it works:</b> Reject heat to seawater via heat exchangers (not immersion).</p>
            <p><b>Constraint:</b> Coastal access + environmental/permits.</p>`
    }
  ];

  list.forEach(card=>{
    const el = document.createElement("div");
    el.className = "cardMini";
    el.innerHTML = `
      <div class="t">${card.title}</div>
      <div class="s">${card.sub}</div>
      <div class="tags">
        ${card.tags.map(t=>`<span class="tag mono">${t}</span>`).join("")}
      </div>
    `;
    el.addEventListener("click", ()=> openDrawer(card));
    box.appendChild(el);
  });
}

function initFutureList(){
  const box = $("futureList");
  box.innerHTML = "";
  FUTURE_IDEAS.forEach((it, idx)=>{
    const el = document.createElement("div");
    el.className = "item" + (idx===0 ? " on" : "");
    el.innerHTML = `<div class="t">${it.title}</div><div class="s">${it.sub}</div>`;
    el.addEventListener("click", ()=>{
      document.querySelectorAll(".item").forEach(x=>x.classList.remove("on"));
      el.classList.add("on");
      lab.idea = it;
      $("labCallout").textContent = it.hint;
      labDraw();
    });
    box.appendChild(el);
  });
}

function initFirebaseIfEnabled(){
  if (!ENABLE_FIREBASE) return;
  if (!window.firebase) return;

  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    firebase.auth().signInAnonymously().catch(console.warn);
    $("arenaMode").textContent = "PUBLIC";
  } catch(e){
    console.warn("Firebase init failed", e);
    db = null;
    $("arenaMode").textContent = "LOCAL";
  }
}

function setClock(){
  const d = new Date();
  const pad=(n)=>String(n).padStart(2,"0");
  $("hudClock").textContent = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function init(){
  buildRackCells();
  paintRack(0.2);

  // drawer events
  $("dClose").addEventListener("click", closeDrawer);
  $("drawer").addEventListener("click", (e)=>{ if (e.target.id === "drawer") closeDrawer(); });

  // Simulator controls
  $("gpuW").addEventListener("input", renderSim);
  $("gpusPer").addEventListener("input", renderSim);
  $("srvPer").addEventListener("input", renderSim);
  $("ovh").addEventListener("input", renderSim);

  $("coolingSeg").querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      $("coolingSeg").querySelectorAll("button").forEach(b=>b.classList.remove("on"));
      btn.classList.add("on");
      simState.cool = btn.dataset.cool;
      $("simMode").textContent = btn.textContent.toUpperCase();
      renderSim();
    });
  });

  initNowCards();
  initFutureList();

  // Future Lab
  $("labLoadSlider").addEventListener("input", ()=>{
    lab.load = Number($("labLoadSlider").value);
    $("labLoad").textContent = `${lab.load}%`;
    labDraw();
  });

  $("labRun").addEventListener("click", ()=>{
    lab.running = true;
    labTick();
  });
  $("labReset").addEventListener("click", ()=>{
    lab.running = false;
    lab.t = 0;
    labDraw();
  });

  // Arena
  loadIdeas();
  renderIdeas(currentSort);

  $("ideaSend").addEventListener("click", submitIdea);
  $("sortHot").addEventListener("click", ()=>{ currentSort="hot"; renderIdeas(currentSort); });
  $("sortNew").addEventListener("click", ()=>{ currentSort="new"; renderIdeas(currentSort); });
  $("sortTop").addEventListener("click", ()=>{ currentSort="top"; renderIdeas(currentSort); });

  // Optional Firebase
  initFirebaseIfEnabled();

  // Clock + initial render
  setClock();
  setInterval(setClock, 1000);
  renderSim();
  labDraw();
}


init();

// --- Code Rain (subtle) ---
(function codeRain(){
  const canvas = document.getElementById("codeRain");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let W=0, H=0, cols=0;
  let drops = [];
  const chars = "01<>/{}[]=+-*#@$%";
  const fontSize = 14;

  function resize(){
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    cols = Math.floor(W / fontSize);
    drops = Array(cols).fill(0).map(()=> Math.random()*H/fontSize);
  }
  window.addEventListener("resize", resize);
  resize();

  function tick(){
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0,0,W,H);

    ctx.font = `700 ${fontSize}px ui-monospace, monospace`;
    for (let i=0;i<cols;i++){
      const x = i * fontSize;
      const y = drops[i] * fontSize;
      const ch = chars[Math.floor(Math.random()*chars.length)];

      ctx.fillStyle = "rgba(0,255,160,0.55)";
      ctx.fillText(ch, x, y);

      if (y > H && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 0.35 + Math.random()*0.25;
    }
    requestAnimationFrame(tick);
  }
  tick();
})();
