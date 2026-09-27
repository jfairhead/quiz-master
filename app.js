(() => {
'use strict';

const ROUND_SIZE = 10;
const ONLINE_PER_ROUND = 6; // when online, up to 6 fresh questions + at least 4 built-in

const CATS = [
  { id:'general',   name:'General knowledge', tapi:'general_knowledge',   otdb:[9] },
  { id:'history',   name:'History',           tapi:'history',             otdb:[23] },
  { id:'geography', name:'Geography',         tapi:'geography',           otdb:[22] },
  { id:'science',   name:'Science & nature',  tapi:'science',             otdb:[17] },
  { id:'music',     name:'Music',             tapi:'music',               otdb:[12] },
  { id:'filmtv',    name:'Film & TV',         tapi:'film_and_tv',         otdb:[11,14] },
  { id:'sport',     name:'Sport',             tapi:'sport_and_leisure',   otdb:[21] },
  { id:'food',      name:'Food & drink',      tapi:'food_and_drink',      otdb:[] },
  { id:'arts',      name:'Books & art',       tapi:'arts_and_literature', otdb:[10,25] },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const TAPI_TO_CAT = Object.fromEntries(CATS.map(c => [c.tapi, c.id]));
const OTDB_TO_CAT = {};
CATS.forEach(c => c.otdb.forEach(id => { OTDB_TO_CAT[id] = c.id; }));
const DIFF_NAME = { 1:'easy', 2:'medium', 3:'hard' };

/* ---------- storage ---------- */
const store = {
  get(k, fallback) { try { const v = localStorage.getItem('cqm:' + k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem('cqm:' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
};
let settings = Object.assign({ cats: CATS.map(c => c.id), mode:'choice', difficulty:'any', online:true }, store.get('settings', {}));
settings.cats = (settings.cats || []).filter(id => CAT[id]);
let stats = Object.assign({ rounds:0, correct:0, answered:0, best:0, byCat:{}, recent:[] }, store.get('stats', {}));
let seen = store.get('seen', []);
let seenSet = new Set(seen);
const saveSettings = () => store.set('settings', settings);
const saveStats = () => store.set('stats', stats);

function markSeen(key) {
  if (seenSet.has(key)) return;
  seenSet.add(key); seen.push(key);
  if (seen.length > 3000) seen.splice(0, seen.length - 3000).forEach(k => seenSet.delete(k));
  store.set('seen', seen);
}

/* ---------- helpers ---------- */
function keyOf(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'q' + (h >>> 0).toString(36);
}
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];
const valid = q => q.q && q.a && Array.isArray(q.wrong) && q.wrong.length === 3;

const BANK = (window.QUESTION_BANK || []).map(x => ({
  key:keyOf(x.q), q:x.q, a:x.a, wrong:x.w, cat:x.c, diff:DIFF_NAME[x.d] || 'medium', src:'Built-in',
})).filter(q => valid(q) && CAT[q.cat]);
const BANK_KEYS = new Set(BANK.map(q => q.key));

/* ---------- question sources ---------- */
function roundRobin(list, n) {
  const byCat = {};
  shuffle(list).forEach(q => (byCat[q.cat] = byCat[q.cat] || []).push(q));
  const cats = shuffle(Object.keys(byCat));
  const out = [];
  let added = true;
  while (out.length < n && added) {
    added = false;
    for (const c of cats) { if (out.length >= n) break; const q = byCat[c].shift(); if (q) { out.push(q); added = true; } }
  }
  return out;
}

function pickBuiltIn(n, exclude) {
  const pool = BANK.filter(q => settings.cats.includes(q.cat) && !exclude.has(q.key));
  const diffOK = q => settings.difficulty === 'any' || q.diff === settings.difficulty;
  const tiers = [
    pool.filter(q => !seenSet.has(q.key) && diffOK(q)),
    pool.filter(q => !seenSet.has(q.key) && !diffOK(q)),
    pool.filter(q => seenSet.has(q.key)), // everything seen: recycle oldest-agnostic
  ];
  const out = [];
  for (const tier of tiers) { if (out.length >= n) break; out.push(...roundRobin(tier, n - out.length)); }
  return out;
}

async function getJSON(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal:ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function fromTriviaApi(n) {
  const slugs = settings.cats.map(id => CAT[id].tapi).join(',');
  let url = `https://the-trivia-api.com/v2/questions?limit=${n}&categories=${encodeURIComponent(slugs)}`;
  if (settings.difficulty !== 'any') url += `&difficulties=${settings.difficulty}`;
  const data = await getJSON(url);
  return (Array.isArray(data) ? data : []).map(x => {
    const text = (x.question && x.question.text) || '';
    return { key:keyOf(text), q:text, a:x.correctAnswer, wrong:(x.incorrectAnswers || []).slice(0, 3),
      cat:TAPI_TO_CAT[x.category] || 'general', diff:x.difficulty || 'medium', src:'The Trivia API' };
  }).filter(q => valid(q) && settings.cats.includes(q.cat));
}

async function fromOpenTdb(n) {
  const ids = settings.cats.flatMap(id => CAT[id].otdb);
  if (!ids.length) return [];
  const id = pickOne(ids);
  let url = `https://opentdb.com/api.php?amount=${n}&type=multiple&encode=url3986&category=${id}`;
  if (settings.difficulty !== 'any') url += `&difficulty=${settings.difficulty}`;
  const data = await getJSON(url);
  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  return ((data && data.results) || []).map(x => {
    const text = dec(x.question);
    return { key:keyOf(text), q:text, a:dec(x.correct_answer), wrong:(x.incorrect_answers || []).map(dec).slice(0, 3),
      cat:OTDB_TO_CAT[id], diff:x.difficulty, src:'Open Trivia DB' };
  }).filter(valid);
}

function interleave(list) {
  const groups = {};
  list.forEach(q => (groups[q.src] = groups[q.src] || []).push(q));
  const lists = Object.values(groups);
  const out = [];
  while (lists.some(l => l.length)) lists.forEach(l => { if (l.length) out.push(l.shift()); });
  return out;
}

async function buildRound() {
  let online = [];
  if (settings.online && navigator.onLine !== false) {
    const results = await Promise.allSettled([fromTriviaApi(8), fromOpenTdb(5)]);
    const uniq = new Map();
    results.forEach(r => { if (r.status === 'fulfilled') r.value.forEach(q => {
      if (!seenSet.has(q.key) && !BANK_KEYS.has(q.key) && !uniq.has(q.key)) uniq.set(q.key, q);
    }); });
    online = interleave(shuffle([...uniq.values()]));
  }
  let chosen = online.slice(0, ONLINE_PER_ROUND);
  const taken = new Set(chosen.map(q => q.key));
  chosen = chosen.concat(pickBuiltIn(ROUND_SIZE - chosen.length, taken));
  if (chosen.length < ROUND_SIZE) {
    const have = new Set(chosen.map(q => q.key));
    chosen = chosen.concat(online.filter(q => !have.has(q.key)).slice(0, ROUND_SIZE - chosen.length));
  }
  return shuffle(chosen).slice(0, ROUND_SIZE).map(q => Object.assign({}, q, { options:shuffle([q.a, ...q.wrong]) }));
}

/* ---------- rendering ---------- */
const app = document.getElementById('app');
let screen = 'home';
let round = null;
let answered = false;
let deferredInstall = null;
let lastRound = null;

function setScreen(name) { screen = name; document.body.dataset.screen = name; }

function refocus(action, id) {
  const sel = id ? `[data-action="${action}"][data-id="${id}"], [data-action="${action}"][data-v="${id}"]` : `[data-action="${action}"]`;
  const el = app.querySelector(sel);
  if (el) el.focus();
}

function summaryLine() {
  if (!stats.rounds) return 'Ten questions a round, then a scorecard. Pick your categories and start.';
  const pct = stats.answered ? Math.round(100 * stats.correct / stats.answered) : 0;
  return `${stats.rounds} ${stats.rounds === 1 ? 'round' : 'rounds'} played. Best round ${stats.best} out of 10. ${pct}% right overall.`;
}

function installHtml() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  if (deferredInstall) return `<div class="stack"><button class="btn-ghost" data-action="install">Install on this device</button></div>`;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return `<p class="hint center">To install on iPhone: open this page in Safari, tap Share, then Add to Home Screen.</p>`;
  return '';
}

function recordHtml() {
  const rows = CATS.filter(c => stats.byCat[c.id] && stats.byCat[c.id].a).map(c => {
    const r = stats.byCat[c.id], pct = Math.round(100 * r.c / r.a);
    return `<div class="rec-row"><span>${esc(c.name)}</span><span class="bar"><i style="width:${pct}%"></i></span><span>${r.c} of ${r.a}</span></div>`;
  }).join('');
  const recent = (stats.recent || []).slice(0, 8).map(r =>
    `<li><strong>${r.score} out of 10</strong>, ${esc(r.date)}, ${esc(r.cats)}</li>`).join('');
  return `<details class="record"><summary>Your record</summary>
    ${rows || '<p class="hint">Play a round and your results by category will show here.</p>'}
    ${recent ? `<ul class="recent">${recent}</ul>` : ''}
    ${stats.rounds ? '<button class="link" data-action="reset">Reset my record</button>' : ''}
  </details>`;
}

function renderHome() {
  setScreen('home');
  const seg = (action, value, label) => `<button data-action="${action}" data-v="${value}" aria-pressed="${settings[action === 'mode' ? 'mode' : 'difficulty'] === value}">${label}</button>`;
  const none = settings.cats.length === 0;
  app.innerHTML = `
    <p class="intro">${esc(summaryLine())}</p>

    <section class="block" aria-labelledby="h-cats">
      <div class="block-head"><h2 id="h-cats">Categories</h2>
        <div class="quick"><button class="link" data-action="all">Select all</button><button class="link" data-action="none">Clear</button></div></div>
      <div class="chips">${CATS.map(c => `<button class="chip" data-action="cat" data-id="${c.id}" aria-pressed="${settings.cats.includes(c.id)}">${esc(c.name)}</button>`).join('')}</div>
    </section>

    <section class="block" aria-labelledby="h-mode">
      <h2 id="h-mode">How to play</h2>
      <div class="seg" role="group" aria-labelledby="h-mode">${seg('mode','choice','Multiple choice')}${seg('mode','pub','Pub rules')}</div>
      <p class="hint">${settings.mode === 'choice' ? 'Pick from four answers.' : 'No options, just like the pub. Say your answer, reveal it, then mark yourself honestly.'}</p>
    </section>

    <section class="block" aria-labelledby="h-diff">
      <h2 id="h-diff">Difficulty</h2>
      <div class="seg" role="group" aria-labelledby="h-diff">${seg('diff','any','Any')}${seg('diff','easy','Easy')}${seg('diff','medium','Medium')}${seg('diff','hard','Hard')}</div>
    </section>

    <section class="block">
      <label class="toggle"><input type="checkbox" data-action="online" ${settings.online ? 'checked' : ''}>
        <span>Mix in fresh questions from online quiz banks</span></label>
      <p class="hint">Needs a connection. Offline, you get the built-in questions.</p>
    </section>

    <button class="btn-start" data-action="start" ${none ? 'disabled' : ''}>Start round</button>
    ${none ? '<p class="warn">Choose at least one category to start.</p>' : ''}
    ${installHtml()}
    ${recordHtml()}`;
}

function pipsHtml() {
  return `<ol class="pips" aria-hidden="true">${round.questions.map((_, k) => {
    const ans = round.answers[k];
    const cls = ans ? (ans.correct ? 'ok' : 'bad') : (k === round.i ? 'now' : '');
    return `<li class="${cls}"></li>`;
  }).join('')}</ol>`;
}

function renderQuestion() {
  setScreen('question');
  answered = false;
  const q = round.questions[round.i];
  const body = settings.mode === 'choice'
    ? `<div class="options" role="group" aria-labelledby="qtext">${q.options.map((o, k) =>
        `<button class="opt opt-${'abcd'[k]}" data-action="pick" data-k="${k}"><span class="letter" aria-hidden="true">${'ABCD'[k]}</span><span>${esc(o)}</span></button>`).join('')}</div>`
    : `<div id="pub"><p class="pub-note">Say your answer out loud, then check.</p><button class="btn-main" data-action="reveal">Show answer</button></div>`;
  app.innerHTML = `
    <div class="qbar"><span>Question ${round.i + 1} of ${round.questions.length}</span><button class="link" data-action="quit">Quit round</button></div>
    ${pipsHtml()}
    <p class="qmeta">${esc(CAT[q.cat].name)}, ${esc(q.diff)}</p>
    <h2 class="qtext" id="qtext" tabindex="-1">${esc(q.q)}</h2>
    ${body}
    <p class="feedback" id="feedback" aria-live="polite"></p>
    <div id="after"></div>`;
  const h = document.getElementById('qtext');
  if (h) h.focus({ preventScroll:true });
  window.scrollTo(0, 0);
}

function recordAnswer(correct, picked) {
  const q = round.questions[round.i];
  answered = true;
  round.answers.push({ correct, picked });
  markSeen(q.key);
  app.querySelector('.pips').outerHTML = pipsHtml();
  const last = round.i === round.questions.length - 1;
  document.getElementById('after').innerHTML =
    `<button class="btn-main" data-action="next">${last ? 'See scorecard' : 'Next question'}</button>`;
}

function pick(k) {
  if (answered) return;
  const q = round.questions[round.i];
  const chosen = q.options[k];
  const correct = chosen === q.a;
  app.querySelectorAll('.opt').forEach((btn, i) => {
    btn.disabled = true;
    if (q.options[i] === q.a) btn.classList.add('is-right');
    else if (i === k) btn.classList.add('is-wrong');
    else btn.classList.add('is-dim');
  });
  const fb = document.getElementById('feedback');
  fb.className = 'feedback ' + (correct ? 'ok' : 'bad');
  fb.textContent = correct ? pickOne(['Correct.', 'Spot on.', 'Nailed it.', 'That’s the one.']) : `Not this time. It’s ${q.a}.`;
  recordAnswer(correct, chosen);
  const next = app.querySelector('[data-action="next"]');
  if (next) next.focus({ preventScroll:true });
}

function reveal() {
  const q = round.questions[round.i];
  document.getElementById('pub').innerHTML = `
    <div class="answer-reveal"><span>The answer is</span><strong>${esc(q.a)}</strong></div>
    <div class="markrow"><button class="btn-got" data-action="mark" data-v="1">I got it</button><button class="btn-miss" data-action="mark" data-v="0">I missed it</button></div>`;
  app.querySelector('[data-action="mark"]').focus({ preventScroll:true });
}

function mark(correct) {
  if (answered) return;
  const q = round.questions[round.i];
  answered = true;
  round.answers.push({ correct, picked:null });
  markSeen(q.key);
  next();
}

function next() {
  if (round.i < round.questions.length - 1) { round.i++; renderQuestion(); }
  else finishRound();
}

function verdict(score) {
  if (score === 10) return 'A perfect round. Drinks are on the other teams.';
  if (score === 9) return 'One away from perfect. Team captain material.';
  if (score >= 7) return 'Strong round. You’d be on the podium tonight.';
  if (score >= 5) return 'Solid and respectable, with room for a comeback.';
  if (score >= 3) return 'A tricky one. The next round’s yours.';
  return 'Every quiz has a round like this. Go again.';
}

function finishRound() {
  const score = round.answers.filter(a => a.correct).length;
  stats.rounds++; stats.answered += round.questions.length; stats.correct += score;
  stats.best = Math.max(stats.best, score);
  round.questions.forEach((q, i) => {
    const r = stats.byCat[q.cat] || (stats.byCat[q.cat] = { c:0, a:0 });
    r.a++; if (round.answers[i].correct) r.c++;
  });
  const catNames = settings.cats.length === CATS.length ? 'all categories' : settings.cats.map(id => CAT[id].name).join(', ');
  const date = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short' });
  stats.recent = [{ score, date, cats:catNames }].concat(stats.recent || []).slice(0, 20);
  saveStats();
  lastRound = Object.assign({ score, catNames }, round);
  renderScore();
}

function renderScore() {
  setScreen('score');
  const r = lastRound;
  const canShare = !!(navigator.share || (navigator.clipboard && navigator.clipboard.writeText));
  const items = r.questions.map((q, i) => {
    const a = r.answers[i];
    return `<li class="${a.correct ? 'ok' : 'bad'}">
      <span class="mark" aria-label="${a.correct ? 'Right' : 'Wrong'}">${a.correct ? '✓' : '✗'}</span>
      <div><p class="cq">${esc(q.q)}</p>
        <p class="ca">Answer: <strong>${esc(q.a)}</strong></p>
        ${!a.correct && a.picked ? `<p class="cy">You said ${esc(a.picked)}</p>` : ''}
        <p class="csrc">${esc(CAT[q.cat].name)}${q.src !== 'Built-in' ? `, from ${esc(q.src)}` : ''}</p></div></li>`;
  }).join('');
  app.innerHTML = `
    <section class="score">
      <p class="score-num"><span class="big">${r.score}</span>out of 10</p>
      <p class="verdict">${esc(verdict(r.score))}</p>
      <div class="stack">
        <button class="btn-start" data-action="start">Play another round</button>
        <button class="btn-ghost" data-action="home">Change categories</button>
        ${canShare ? '<button class="btn-ghost" data-action="share">Share score</button>' : ''}
      </div>
      <p class="feedback" id="feedback" aria-live="polite"></p>
    </section>
    <ol class="card-list" aria-label="Round answers">${items}</ol>`;
  window.scrollTo(0, 0);
}

async function share() {
  const r = lastRound;
  const grid = r.answers.map(a => a.correct ? '🟩' : '🟥').join('');
  const text = `Clarrie's Quiz Machine: ${r.score}/10 (${r.catNames})\n${grid}`;
  const fb = document.getElementById('feedback');
  try {
    if (navigator.share) await navigator.share({ title:"Clarrie's Quiz Machine", text, url:location.href });
    else { await navigator.clipboard.writeText(text + '\n' + location.href); fb.className = 'feedback ok'; fb.textContent = 'Score copied. Paste it into a message.'; }
  } catch (e) { /* share cancelled */ }
}

async function startRound() {
  if (!settings.cats.length) return;
  setScreen('question');
  app.innerHTML = `<p class="loading" role="status">Shuffling the questions…</p>`;
  const questions = await buildRound();
  if (!questions.length) { renderHome(); return; }
  round = { questions, i:0, answers:[] };
  renderQuestion();
}

/* ---------- events ---------- */
app.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  const { action } = b.dataset;
  switch (action) {
    case 'cat': {
      const id = b.dataset.id;
      settings.cats = settings.cats.includes(id) ? settings.cats.filter(x => x !== id) : settings.cats.concat(id);
      saveSettings(); renderHome(); refocus('cat', id); break;
    }
    case 'all': settings.cats = CATS.map(c => c.id); saveSettings(); renderHome(); refocus('all'); break;
    case 'none': settings.cats = []; saveSettings(); renderHome(); refocus('none'); break;
    case 'mode': settings.mode = b.dataset.v; saveSettings(); renderHome(); refocus('mode', b.dataset.v); break;
    case 'diff': settings.difficulty = b.dataset.v; saveSettings(); renderHome(); refocus('diff', b.dataset.v); break;
    case 'start': startRound(); break;
    case 'pick': pick(Number(b.dataset.k)); break;
    case 'reveal': reveal(); break;
    case 'mark': mark(b.dataset.v === '1'); break;
    case 'next': next(); break;
    case 'quit': if (confirm('Quit this round? Answers so far won’t be scored.')) renderHome(); break;
    case 'home': renderHome(); break;
    case 'share': share(); break;
    case 'reset':
      if (confirm('Reset your record? This clears scores and which questions you’ve seen.')) {
        stats = { rounds:0, correct:0, answered:0, best:0, byCat:{}, recent:[] }; seen = []; seenSet = new Set();
        saveStats(); store.set('seen', seen); renderHome();
      }
      break;
    case 'install':
      if (deferredInstall) { deferredInstall.prompt(); deferredInstall.userChoice.finally(() => { deferredInstall = null; renderHome(); }); }
      break;
  }
});

app.addEventListener('change', e => {
  if (e.target.dataset.action === 'online') { settings.online = e.target.checked; saveSettings(); }
});

document.addEventListener('keydown', e => {
  if (screen !== 'question' || answered || !round || settings.mode !== 'choice') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const map = { '1':0, '2':1, '3':2, '4':3, a:0, b:1, c:2, d:3 };
  const k = map[e.key.toLowerCase()];
  if (k !== undefined) { e.preventDefault(); pick(k); }
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredInstall = e;
  if (screen === 'home') renderHome();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

renderHome();
})();
