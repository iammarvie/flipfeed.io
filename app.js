"use strict";

const $ = id => document.getElementById(id);
const DB_NAME = "flipfeed";
const DB_VERSION = 1;
const DAY = 86400000;
const defaults = { retention: 0.9, newLimit: 20, reviewLimit: 200 };
const state = { decks: [], view: "library", deckId: null, queue: [], position: 0, revealed: false, sessionReviewed: 0, touchY: null, editingId: null };

const uid = () => crypto.randomUUID();
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const plainText = html => new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();
const localDay = date => { const d = new Date(date); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const selectedDeck = () => state.decks.find(deck => deck.id === state.deckId);

let database;
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("decks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transaction(mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction("decks", mode);
    const result = callback(tx.objectStore("decks"));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}
async function loadDecks() {
  state.decks = await new Promise((resolve, reject) => {
    const request = database.transaction("decks").objectStore("decks").getAll();
    request.onsuccess = () => resolve(request.result.sort((a,b) => a.createdAt.localeCompare(b.createdAt)));
    request.onerror = () => reject(request.error);
  });
}
async function saveDeck(deck) {
  deck.updatedAt = new Date().toISOString();
  await transaction("readwrite", store => store.put(deck));
  const i = state.decks.findIndex(item => item.id === deck.id);
  if (i < 0) state.decks.push(deck); else state.decks[i] = deck;
}
async function removeDeck(id) {
  await transaction("readwrite", store => store.delete(id));
  state.decks = state.decks.filter(deck => deck.id !== id);
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
function formatRelative(value) {
  if (!value) return "Not studied yet";
  const days = Math.floor((Date.now() - new Date(value)) / DAY);
  if (days <= 0) return "Studied today";
  if (days === 1) return "Studied yesterday";
  return `Studied ${days} days ago`;
}
function stats(deck = null) {
  const reviews = deck ? deck.reviews : state.decks.flatMap(d => d.reviews);
  const counts = reviews.reduce((result, review) => { const day = localDay(review.date); result[day] = (result[day] || 0) + 1; return result; }, {});
  let cursor = new Date();
  if (!counts[localDay(cursor)]) cursor = new Date(Date.now() - DAY);
  let streak = 0;
  while (counts[localDay(cursor)]) { streak++; cursor = new Date(cursor.getTime() - DAY); }
  return { today: counts[localDay(new Date())] || 0, total: reviews.length, streak };
}
function dueCards(deck) {
  const now = Date.now();
  const scheduled = deck.cards.filter(card => card.schedule && new Date(card.schedule.due).getTime() <= now)
    .sort((a,b) => a.schedule.due.localeCompare(b.schedule.due)).slice(0, deck.settings.reviewLimit);
  const fresh = deck.cards.filter(card => !card.schedule).slice(0, deck.settings.newLimit);
  return [...scheduled, ...fresh];
}
function intervalFor(card, rating, settings) {
  const schedule = card.schedule;
  if (!schedule) return rating === 1 ? 10 / 1440 : rating === 2 ? 0.5 : rating === 3 ? 1 : 4;
  const elapsed = Math.max(0.01, (Date.now() - new Date(schedule.lastReview).getTime()) / DAY);
  const stability = Math.max(0.1, schedule.stability || schedule.interval || 1);
  const retrievability = Math.pow(0.9, elapsed / stability);
  const retentionScale = Math.log(settings.retention) / Math.log(0.9);
  if (rating === 1) return 10 / 1440;
  const factors = {2: 1.18, 3: 2.45, 4: 3.8};
  const memoryBonus = 1 + Math.max(0, 1 - retrievability) * 1.8;
  return Math.max(rating === 2 ? stability : stability + 1, stability * factors[rating] * memoryBonus / retentionScale);
}
function intervalLabel(days) {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m`;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
function rateCard(card, rating) {
  const deck = selectedDeck();
  const previous = card.schedule;
  const interval = intervalFor(card, rating, deck.settings);
  const oldDifficulty = previous?.difficulty || 5;
  const difficulty = Math.min(10, Math.max(1, oldDifficulty + ({1:1.2,2:0.45,3:-0.05,4:-0.65}[rating])));
  const oldStability = previous?.stability || 0.4;
  const stability = rating === 1 ? Math.max(0.1, oldStability * 0.35) : Math.max(interval, oldStability);
  const now = new Date();
  card.schedule = { due: new Date(now.getTime() + interval * DAY).toISOString(), lastReview: now.toISOString(), interval, stability, difficulty, reps: (previous?.reps || 0) + 1, lapses: (previous?.lapses || 0) + (rating === 1 ? 1 : 0) };
  deck.reviews.push({ id: uid(), cardId: card.id, rating, date: now.toISOString() });
  state.sessionReviewed++;
  if (rating <= 2) {
    const offset = rating === 1 ? 3 : 5;
    const insertion = Math.min(state.queue.length, state.position + offset);
    state.queue.splice(insertion, 0, card);
  }
  state.position++;
  state.revealed = false;
  saveDeck(deck).then(renderStudy);
}

function sanitizeHTML(html, deck) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const allowed = new Set(["B","I","U","EM","STRONG","BR","DIV","P","SPAN","SMALL","SUP","SUB","UL","OL","LI","HR","IMG","A","TABLE","TBODY","THEAD","TR","TD","TH","AUDIO","SOURCE"]);
  function clean(node) {
    [...node.children].forEach(child => {
      if (!allowed.has(child.tagName)) { child.replaceWith(...child.childNodes); return; }
      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        if (name === "src" && ["IMG","AUDIO","SOURCE"].includes(child.tagName)) {
          const raw = decodeURIComponent(attr.value).replace(/^.*[\\/]/, "");
          if (deck.media?.[raw]) child.setAttribute("src", deck.media[raw]); else child.removeAttribute("src");
        } else if (name === "href" && child.tagName === "A" && /^https:\/\//i.test(attr.value)) {
          child.setAttribute("rel", "noopener noreferrer"); child.setAttribute("target", "_blank");
        } else if (!(name === "class" && attr.value === "cloze")) child.removeAttribute(attr.name);
      });
      clean(child);
    });
  }
  clean(doc.body);
  doc.body.innerHTML = doc.body.innerHTML.replace(/\[sound:([^\]]+)\]/g, (_, file) => deck.media?.[file] ? `<audio controls src="${deck.media[file]}"></audio>` : "");
  return doc.body.innerHTML;
}

function renderLibrary() {
  state.view = "library";
  const summary = stats();
  $("main").innerHTML = state.decks.length ? `
    <section><div class="page-head"><div><h1>Your decks</h1><p>${summary.today} reviews today · ${summary.streak} day streak</p></div><button class="primary-button" id="page-create">＋ Create deck</button></div>
    <div class="stats-row"><div class="stat"><strong>${state.decks.length}</strong><span>Decks</span></div><div class="stat"><strong>${state.decks.reduce((n,d)=>n+d.cards.length,0)}</strong><span>Cards</span></div><div class="stat"><strong>${summary.total}</strong><span>Total reviews</span></div></div>
    <label class="search-wrap"><span class="search-icon">⌕</span><input id="search" type="search" placeholder="Search decks, cards, and tags"></label>
    <div id="deck-grid" class="deck-grid"></div></section>` : `
    <section class="welcome"><div class="welcome-inner"><div class="welcome-mark">F</div><h1>Your deck.<br>A fresh perspective.</h1><p>Import an Anki deck or build one here, then study one card at a time. Your library remains private on this device.</p><div class="welcome-actions"><button class="primary-button" id="welcome-import">⇩ Import .apkg</button><button class="secondary-button" id="welcome-create">＋ Create deck</button></div></div></section>`;
  if (!state.decks.length) {
    $("welcome-import").onclick = () => $("apkg-input").click();
    $("welcome-create").onclick = () => openEditor();
    return;
  }
  $("page-create").onclick = () => openEditor();
  $("search").oninput = event => renderDeckGrid(event.target.value);
  renderDeckGrid("");
}
function renderDeckGrid(query) {
  const q = query.trim().toLowerCase();
  const decks = state.decks.filter(deck => !q || deck.name.toLowerCase().includes(q) || deck.cards.some(card => plainText(card.front).toLowerCase().includes(q) || plainText(card.back).toLowerCase().includes(q) || card.tags.some(tag => tag.toLowerCase().includes(q))));
  $("deck-grid").innerHTML = decks.length ? decks.map(deck => {
    const due = dueCards(deck).length;
    const fresh = deck.cards.filter(card => !card.schedule).length;
    const last = deck.reviews.at(-1)?.date;
    return `<article class="deck-card"><div class="deck-card-top"><div><h2>${escapeHTML(deck.name)}</h2><p>${deck.cards.length} cards · ${fresh} new</p></div><span class="due-pill ${due ? "" : "done"}">${due ? `${due} DUE` : "DONE"}</span></div><div class="deck-card-footer"><small>${formatRelative(last)}</small><button class="secondary-button menu-button delete-deck" data-id="${deck.id}" title="Delete deck">⌫</button><button class="secondary-button menu-button edit-deck" data-id="${deck.id}" title="Edit deck">✎</button><button class="secondary-button menu-button settings-deck" data-id="${deck.id}" title="Deck settings">⚙</button><button class="primary-button study-deck" data-id="${deck.id}">${due ? "Study" : "Open"}</button></div></article>`;
  }).join("") : `<div class="empty-state">No decks or cards match that search.</div>`;
  document.querySelectorAll(".study-deck").forEach(button => button.onclick = () => startStudy(button.dataset.id));
  document.querySelectorAll(".edit-deck").forEach(button => button.onclick = () => openEditor(button.dataset.id));
  document.querySelectorAll(".settings-deck").forEach(button => button.onclick = () => openSettings(button.dataset.id));
  document.querySelectorAll(".delete-deck").forEach(button => button.onclick = async () => {
    const deck = state.decks.find(item => item.id === button.dataset.id);
    if (confirm(`Delete ${deck.name}? Its cards, history, schedules, and media will be removed from this device.`)) { await removeDeck(deck.id); renderLibrary(); toast("Deck deleted"); }
  });
}
function startStudy(id) {
  state.view = "study"; state.deckId = id; state.queue = dueCards(selectedDeck()); state.position = 0; state.revealed = false; state.sessionReviewed = 0;
  renderStudy();
}
function renderStudy() {
  const deck = selectedDeck();
  const card = state.queue[state.position];
  if (!card) {
    $("main").innerHTML = `<section class="study-layout"><div class="complete"><div class="welcome-mark">✓</div><h1>Session complete</h1><p class="muted">${state.sessionReviewed ? `${state.sessionReviewed} reviews recorded.` : "Nothing is due right now."}</p><div class="welcome-actions"><button id="done-library" class="primary-button">Back to library</button><button id="study-all" class="secondary-button">Study all cards</button></div></div></section>`;
    $("done-library").onclick = renderLibrary;
    $("study-all").onclick = () => { state.queue = [...deck.cards]; state.position = 0; renderStudy(); };
    return;
  }
  const progress = Math.min(100, ((state.position + 1) / state.queue.length) * 100);
  const intervals = [1,2,3,4].map(rating => intervalLabel(intervalFor(card, rating, deck.settings)));
  $("main").innerHTML = `<section class="study-layout"><div class="study-head"><button id="study-back" class="plain-button" aria-label="Back to library">←</button><span>${state.position + 1} / ${state.queue.length}</span><div class="track"><i style="width:${progress}%"></i></div><span>${state.revealed ? "ANSWER" : "QUESTION"}</span></div><article id="study-card" class="study-card ${state.revealed ? "answer" : ""}" tabindex="0"><div class="card-label">${escapeHTML(deck.name)}${card.tags.length ? ` / ${escapeHTML(card.tags.slice(0,2).join(", "))}` : ""}</div><div class="card-content">${sanitizeHTML(state.revealed ? card.back : card.front, deck)}</div><div class="reveal-hint">${state.revealed ? "Choose how well you remembered" : "Tap to reveal the answer"}</div></article>${state.revealed ? `<div class="rating-row">${["Again","Hard","Good","Easy"].map((name,i)=>`<button data-rating="${i+1}"><strong>${name}</strong><small>${intervals[i]}</small></button>`).join("")}</div>` : ""}</section>`;
  $("study-back").onclick = renderLibrary;
  const cardNode = $("study-card");
  const reveal = () => { state.revealed = !state.revealed; renderStudy(); };
  cardNode.onclick = reveal;
  cardNode.onkeydown = event => { if (["Enter"," "].includes(event.key)) { event.preventDefault(); reveal(); } };
  cardNode.ontouchstart = event => state.touchY = event.touches[0].clientY;
  cardNode.ontouchend = event => { const delta = event.changedTouches[0].clientY - state.touchY; if (Math.abs(delta) > 65) { if (delta < 0 && !state.revealed) reveal(); else if (delta < 0) rateCard(card, 3); } };
  document.querySelectorAll("[data-rating]").forEach(button => button.onclick = event => { event.stopPropagation(); rateCard(card, Number(button.dataset.rating)); });
}
function renderHistory() {
  state.view = "history";
  const reviews = state.decks.flatMap(deck => deck.reviews.map(review => ({...review, deck: deck.name}))).sort((a,b) => b.date.localeCompare(a.date));
  const summary = stats();
  $("main").innerHTML = `<section><div class="page-head"><div><h1>Study history</h1><p>${summary.total} reviews across ${state.decks.length} decks</p></div></div><div class="stats-row"><div class="stat"><strong>${summary.today}</strong><span>Today</span></div><div class="stat"><strong>${summary.streak}</strong><span>Day streak</span></div><div class="stat"><strong>${new Set(reviews.map(r=>r.cardId)).size}</strong><span>Cards studied</span></div></div><div class="history-list">${reviews.length ? reviews.slice(0,200).map(review => `<div class="history-row"><strong>${escapeHTML(review.deck)}</strong><span>${["","Again","Hard","Good","Easy"][review.rating]}</span><time>${new Date(review.date).toLocaleString()}</time></div>`).join("") : `<div class="empty-state">Your completed reviews will appear here.</div>`}</div></section>`;
}

function addCardRow(card = {}) {
  const row = document.createElement("div");
  row.className = "card-row"; row.dataset.id = card.id || uid();
  row.innerHTML = `<div class="card-row-head"><strong>Card</strong><button class="remove-card" type="button">Delete</button></div><label class="field"><span>Front</span><textarea class="front" required>${escapeHTML(plainText(card.front || ""))}</textarea></label><label class="field"><span>Back</span><textarea class="back" required>${escapeHTML(plainText(card.back || ""))}</textarea></label><label class="field"><span>Tags</span><input class="tags" value="${escapeHTML((card.tags || []).join(", "))}" placeholder="comma, separated"></label>`;
  row.querySelector(".remove-card").onclick = () => row.remove();
  $("card-rows").append(row);
}
function openEditor(id = null) {
  state.editingId = id; const deck = state.decks.find(item => item.id === id);
  $("editor-title").textContent = deck ? "Edit deck" : "Create deck";
  $("deck-title-input").value = deck?.name || ""; $("card-rows").innerHTML = "";
  (deck?.cards.length ? deck.cards : [{}]).forEach(addCardRow); $("editor-dialog").showModal();
}
function openSettings(id) {
  state.deckId = id; const settings = selectedDeck().settings;
  $("retention-input").value = Math.round(settings.retention * 100); $("retention-output").textContent = `${Math.round(settings.retention * 100)}%`;
  $("new-limit-input").value = settings.newLimit; $("review-limit-input").value = settings.reviewLimit; $("settings-dialog").showModal();
}

function renderTemplate(template, fields, front = "") {
  return template.replace(/{{([#/^][^}]+)}}/g, "").replace(/{{([^}]+)}}/g, (_, raw) => { const key = raw.trim(); if (key === "FrontSide") return front; return fields[key.split(":").at(-1)] || ""; });
}
function renderCloze(value, ordinal, answer) {
  return value.replace(/{{c(\d+)::(.*?)(?:::(.*?))?}}/gs, (_, number, text, hint) => Number(number) === ordinal && !answer ? `<span class="cloze">[${hint || "..."}]</span>` : text);
}
function bytesToDataURL(bytes, filename) {
  let binary = ""; const chunk = 0x8000;
  for (let i=0;i<bytes.length;i+=chunk) binary += String.fromCharCode(...bytes.subarray(i,i+chunk));
  const extension = filename.split(".").pop().toLowerCase();
  const mime = ({png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",svg:"image/svg+xml",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4"})[extension] || "application/octet-stream";
  return `data:${mime};base64,${btoa(binary)}`;
}
async function importAPKG(file) {
  toast("Reading Anki deck…");
  const zip = await JSZip.loadAsync(file);
  const dbName = ["collection.anki21","collection.anki2"].find(name => zip.file(name));
  if (!dbName) throw new Error(zip.file("collection.anki21b") ? "Export this deck from Anki with legacy compatibility enabled." : "This is not a supported Anki package.");
  const SQL = await initSqlJs({ locateFile: name => `./vendor/${name}` });
  const db = new SQL.Database(await zip.file(dbName).async("uint8array"));
  const metadata = db.exec("SELECT models, decks FROM col LIMIT 1")[0];
  if (!metadata) throw new Error("The Anki collection is empty.");
  const models = JSON.parse(metadata.values[0][0]); const decks = JSON.parse(metadata.values[0][1]);
  const result = db.exec("SELECT c.id, c.ord, c.did, n.mid, n.flds, n.tags FROM cards c JOIN notes n ON n.id=c.nid ORDER BY c.id")[0]; db.close();
  if (!result) throw new Error("No cards were found in this package.");
  const cards = result.values.map(row => {
    const [id, ordinal, deckId, modelId, rawFields, rawTags] = row; const model = models[String(modelId)]; if (!model) return null;
    const values = rawFields.split("\x1f"); const fields = Object.fromEntries(model.flds.map((field,i) => [field.name, values[i] || ""])); const template = model.tmpls[Math.min(ordinal, model.tmpls.length-1)];
    let front = renderTemplate(template.qfmt || "", fields); let back = renderTemplate(template.afmt || "", fields, front);
    if (model.type === 1) { front = renderCloze(front, ordinal+1, false); back = renderCloze(back, ordinal+1, true); }
    return { id: String(id), front, back, tags: rawTags.trim().split(/\s+/).filter(Boolean) };
  }).filter(Boolean);
  const media = {}; const mediaFile = zip.file("media");
  if (mediaFile) { const map = JSON.parse(await mediaFile.async("string")); for (const [key,name] of Object.entries(map)) { const entry = zip.file(key); if (entry && !name.includes("/") && !name.includes("\\")) media[name] = bytesToDataURL(await entry.async("uint8array"), name); } }
  const name = decks[String(result.values[0][2])]?.name || file.name.replace(/\.apkg$/i, "");
  const deck = { id: uid(), name, cards, media, reviews: [], settings: {...defaults}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), syncState: "local" };
  await saveDeck(deck); renderLibrary(); toast(`${cards.length} cards imported`);
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ format:"flipfeed-backup", version:1, exportedAt:new Date().toISOString(), decks:state.decks })], {type:"application/json"});
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `flipfeed-backup-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href); toast("Backup exported");
}
async function restoreBackup(file) {
  const data = JSON.parse(await file.text()); if (data.format !== "flipfeed-backup" || !Array.isArray(data.decks)) throw new Error("That is not a Flipfeed backup.");
  for (const deck of data.decks) await saveDeck(deck); renderLibrary(); toast(`${data.decks.length} decks restored`);
}

$("brand-button").onclick = renderLibrary;
$("history-button").onclick = renderHistory;
$("add-button").onclick = () => openEditor();
$("more-button").onclick = () => $("action-dialog").showModal();
$("import-action").onclick = () => { $("action-dialog").close(); $("apkg-input").click(); };
$("export-action").onclick = () => { $("action-dialog").close(); exportBackup(); };
$("restore-action").onclick = () => { $("action-dialog").close(); $("backup-input").click(); };
document.querySelectorAll(".close-dialog").forEach(button => button.onclick = () => button.closest("dialog").close());
$("add-card-row").onclick = () => addCardRow();
$("retention-input").oninput = event => $("retention-output").textContent = `${event.target.value}%`;
$("deck-form").onsubmit = async event => {
  event.preventDefault(); const rows = [...document.querySelectorAll(".card-row")];
  if (!rows.length) return toast("Add at least one card.");
  const existing = state.decks.find(deck => deck.id === state.editingId);
  const oldCards = Object.fromEntries((existing?.cards || []).map(card => [card.id,card]));
  const cards = rows.map(row => { const id=row.dataset.id; const old=oldCards[id]; return {id,front:escapeHTML(row.querySelector(".front").value).replace(/\n/g,"<br>"),back:escapeHTML(row.querySelector(".back").value).replace(/\n/g,"<br>"),tags:row.querySelector(".tags").value.split(",").map(x=>x.trim()).filter(Boolean),schedule:old?.schedule}; });
  const deck = existing ? {...existing,name:$("deck-title-input").value.trim(),cards} : {id:uid(),name:$("deck-title-input").value.trim(),cards,media:{},reviews:[],settings:{...defaults},createdAt:new Date().toISOString(),syncState:"local"};
  await saveDeck(deck); $("editor-dialog").close(); renderLibrary(); toast(existing ? "Deck updated" : "Deck created");
};
$("settings-form").onsubmit = async event => { event.preventDefault(); const deck=selectedDeck(); deck.settings={retention:Number($("retention-input").value)/100,newLimit:Number($("new-limit-input").value),reviewLimit:Number($("review-limit-input").value)}; await saveDeck(deck); $("settings-dialog").close(); renderLibrary(); toast("Settings saved"); };
$("apkg-input").onchange = async event => { const file=event.target.files[0]; event.target.value=""; if (!file) return; try { await importAPKG(file); } catch(error) { console.error(error); toast(error.message || "Import failed"); } };
$("backup-input").onchange = async event => { const file=event.target.files[0]; event.target.value=""; if (!file) return; try { await restoreBackup(file); } catch(error) { toast(error.message || "Restore failed"); } };
document.addEventListener("keydown", event => { if (state.view !== "study" || !selectedDeck()) return; const card=state.queue[state.position]; if (!card) return; if (event.key === " " && !["INPUT","TEXTAREA"].includes(event.target.tagName)) { event.preventDefault(); state.revealed=!state.revealed; renderStudy(); } if (state.revealed && ["1","2","3","4"].includes(event.key)) rateCard(card,Number(event.key)); });

async function boot() {
  database = await openDB(); await loadDecks(); renderLibrary();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(console.error);
}
boot().catch(error => { console.error(error); $("main").innerHTML = `<div class="empty-state">Flipfeed could not open its local library. ${escapeHTML(error.message)}</div>`; });
