'use strict';
// Bilancio on the phone. The ledger is indexed by its folders: dati/<persona>/<portafoglio>/<anno>.csv, each
// portfolio with a portafoglio.json saying whether it counts euro or bitcoin. The web app reads the same files
// and Syncthing carries every change to the PC and the Pi. Nothing here needs a network except the BTC price.

const A = window.Archivio;

const COLONNE = {
    fiat: ['id', 'data', 'importo', 'persona', 'conto', 'tipologia', 'categoria', 'descrizione'],
    bitcoin: ['id', 'data', 'euro', 'bitcoin', 'prezzo', 'persona', 'conto', 'descrizione'],
};
const VALUTA = { EUR: 'fiat', BTC: 'bitcoin' };
const ANNO_CSV = /^\d{4}\.csv$/;
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

const S = {
    portafogli: new Map(), // 'Alan/BBVA' -> { persona, nome, cartella, valuta, tipo }
    file: {},              // 'Alan/BBVA/2026.csv' -> { mtime, size, conto, persona, tipo, righe }
    conflitti: [],
    vecchioFormato: false,
    tab: 'home',
    strato: 'cold',
    mese: oggi().slice(0, 7),
    anno: Number(oggi().slice(0, 4)),
    persona: '',
    conto: '',
    cerca: '',
    vistaCat: 'mese',
    catAperta: '',
    vistaMov: 'lista',
    calScala: 'mese',
    calSettimana: '',
    btcPeriodo: 'mese',
    btcScelto: '',
    calColore: 'persona',
    calGiorno: '',
    bolPeriodo: 'mese',
    bolTipo: '',
    bolScelto: '',
    foglio: null,
    prezzo: leggiLocale('bilancio.prezzo', null),
};
const pref = {
    get io() { return leggiLocale('bilancio.io', ''); },
    set io(v) { scriviLocale('bilancio.io', v); },
    get unita() { return leggiLocale('bilancio.unita', 'BTC'); },
    set unita(v) { scriviLocale('bilancio.unita', v); },
};

// ---------- small helpers ----------

function oggi() {
    return giorno(new Date());
}
function giorno(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function leggiLocale(k, def) {
    try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; }
}
function scriviLocale(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* nothing to remember then */ }
}
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function euro(n, segno = false) {
    const s = Math.abs(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${n < 0 ? '−' : segno && n > 0 ? '+' : ''}€ ${s}`;
}
function euroTondo(n) {
    return `${n < 0 ? '−' : ''}€ ${Math.round(Math.abs(n)).toLocaleString('it-IT')}`;
}
function btc(n) {
    if (pref.unita === 'SAT') return `${Math.round(n * 1e8).toLocaleString('it-IT')} sat`;
    return `${n.toLocaleString('it-IT', { minimumFractionDigits: 8, maximumFractionDigits: 8 })} BTC`;
}
// Accepts "12,50", "12.50", "1.234,56", "1,234.56", "-€ 3,00", "12.34 EUR".
function numero(s) {
    let t = String(s ?? '').trim().replace(/[^\d,.\-+]/g, '');
    const v = t.lastIndexOf(','), p = t.lastIndexOf('.');
    if (v >= 0 && p >= 0) t = v > p ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (v >= 0) t = t.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
}
function nuovoId() {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function nomeMese(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
}
function spostaMese(ym, d) {
    const [y, m] = ym.split('-').map(Number);
    const t = new Date(y, m - 1 + d, 1);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}
function perUso(valori) {
    const n = new Map();
    for (const v of valori) if (v) n.set(v, (n.get(v) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}
function avvisa(testo) {
    const el = document.getElementById('avviso');
    el.textContent = testo;
    el.hidden = false;
    clearTimeout(avvisa.t);
    avvisa.t = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- CSV, the same shape the web app writes ----------

function righeCSV(testo, sep = ',') {
    const righe = [];
    let riga = [], campo = '', virgolette = false;
    for (let i = 0; i < testo.length; i++) {
        const c = testo[i];
        if (virgolette) {
            if (c === '"' && testo[i + 1] === '"') { campo += '"'; i++; }
            else if (c === '"') virgolette = false;
            else campo += c;
        } else if (c === '"') virgolette = true;
        else if (c === sep) { riga.push(campo); campo = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && testo[i + 1] === '\n') i++;
            riga.push(campo); campo = '';
            if (riga.length > 1 || riga[0] !== '') righe.push(riga);
            riga = [];
        } else campo += c;
    }
    if (campo !== '' || riga.length) { riga.push(campo); righe.push(riga); }
    return righe;
}

function daCSV(p, testo) {
    const [testa, ...corpo] = righeCSV((testo || '').replace(/^﻿/, ''));
    if (!testa) return [];
    return corpo.map(r => {
        const o = Object.fromEntries(testa.map((k, i) => [k, r[i] ?? '']));
        return {
            tipo: p.tipo, conto: p.nome, persona: p.persona, id: o.id || nuovoId(), data: o.data,
            importo: p.tipo === 'fiat' ? Number(o.importo) || 0 : 0,
            tipologia: o.tipologia || '', categoria: o.categoria || '', descrizione: o.descrizione || '',
            euro: p.tipo === 'bitcoin' ? Number(o.euro) || 0 : 0,
            bitcoin: p.tipo === 'bitcoin' ? Number(o.bitcoin) || 0 : 0,
            prezzo: o.prezzo ? Number(o.prezzo) : null,
        };
    });
}

function cella(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function aCSV(tipo, righe) {
    const valore = (m, k) => {
        if (k === 'importo' || k === 'euro') return m[k].toFixed(2);
        if (k === 'bitcoin') return m.bitcoin.toFixed(8);
        if (k === 'prezzo') return m.prezzo == null ? '' : String(Math.round(m.prezzo * 100) / 100);
        return m[k];
    };
    const ordinate = [...righe].sort((a, b) => a.data.localeCompare(b.data));
    return [COLONNE[tipo].join(','), ...ordinate.map(m => COLONNE[tipo].map(k => cella(valore(m, k))).join(','))].join('\n') + '\n';
}

// ---------- portfolios and files ----------

function elenco(sub) {
    try { return JSON.parse(A.elenco(sub) || '[]'); } catch { return []; }
}

function carica() {
    const conflitti = [];
    const portafogli = new Map();
    const presenti = new Set();
    const radice = elenco('');
    for (const d of radice) {
        if (d.nome.includes('sync-conflict')) conflitti.push(d.nome);
        if (!d.dir) continue;
        for (const c of elenco(d.nome)) {
            if (!c.dir) continue;
            const cartella = `${d.nome}/${c.nome}`;
            const figli = elenco(cartella);
            if (!figli.some(f => f.nome === 'portafoglio.json')) continue;
            let meta = {};
            try { meta = JSON.parse(A.leggi(`${cartella}/portafoglio.json`) || '{}'); } catch { meta = {}; }
            const valuta = meta.valuta === 'BTC' ? 'BTC' : 'EUR';
            // A bitcoin portfolio is on-chain unless its file says Lightning, and cold unless it says hot.
            const rete = valuta === 'BTC' ? (meta.rete === 'LN' ? 'LN' : 'onchain') : null;
            const strato = valuta !== 'BTC' ? 'fiat' : rete === 'LN' ? 'ln' : meta.custodia === 'hot' ? 'hot' : 'cold';
            const p = { persona: d.nome, nome: meta.nome || c.nome, cartella, valuta, tipo: VALUTA[valuta], rete, strato, stratoScelto: rete === 'LN' || !!meta.custodia };
            portafogli.set(`${p.persona}/${p.nome}`, p);
            for (const f of figli) {
                if (f.nome.includes('sync-conflict')) conflitti.push(`${cartella}/${f.nome}`);
                if (!ANNO_CSV.test(f.nome)) continue;
                const k = `${cartella}/${f.nome}`;
                presenti.add(k);
                const x = S.file[k];
                if (x && x.mtime === f.mtime && x.size === f.size && x.conto === p.nome && x.tipo === p.tipo) continue;
                S.file[k] = { mtime: f.mtime, size: f.size, conto: p.nome, persona: p.persona, tipo: p.tipo, righe: daCSV(p, A.leggi(k)) };
            }
        }
    }
    for (const k of Object.keys(S.file)) if (!presenti.has(k)) delete S.file[k];
    S.portafogli = portafogli;
    S.conflitti = conflitti;
    // The layout before portfolios had their own folders; Syncthing may still be bringing the new one.
    S.vecchioFormato = !portafogli.size && radice.some(d => d.dir && (d.nome === 'fiat' || d.nome === 'bitcoin'));
}

function tutti(tipo) {
    return Object.values(S.file).filter(f => f.tipo === tipo).flatMap(f => f.righe);
}

function portafogliDi(tipo) {
    return [...S.portafogli.values()].filter(p => p.tipo === tipo);
}

// Android storage and Windows ignore case, so "Mps" and "MPS" are the same folder: one portfolio.
function stesso(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function trovaPortafoglio(persona, nome) {
    return [...S.portafogli.values()].find(p => stesso(p.persona, persona) && (stesso(p.nome, nome) || stesso(p.cartella.split('/')[1], nome)));
}

function nomeCartella(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim();
}

function metaPortafoglio(nome, valuta, strato) {
    if (valuta !== 'BTC') return { nome, valuta };
    return strato === 'ln' ? { nome, valuta, rete: 'LN' } : { nome, valuta, custodia: strato === 'hot' ? 'hot' : 'cold' };
}

function creaPortafoglio(persona, nome, valuta, strato) {
    persona = String(persona || '').trim();
    nome = String(nome || '').trim();
    if (!persona) throw new Error('Manca la persona');
    if (!nome) throw new Error('Manca il nome del portafoglio');
    if (trovaPortafoglio(persona, nome)) throw new Error(`${persona} ha già un portafoglio "${nome}"`);
    // An existing person folder is reused whatever its case, so "alan" does not start a second Alan.
    const cp = elenco('').find(d => d.dir && stesso(d.nome, persona))?.nome || nomeCartella(persona);
    const cn = nomeCartella(nome);
    if (!cp || !cn) throw new Error('Nome non valido');
    if (elenco(cp).some(d => stesso(d.nome, cn))) throw new Error(`C'è già una cartella ${cp}/${cn}`);
    const errore = A.scrivi(`${cp}/${cn}/portafoglio.json`, JSON.stringify(metaPortafoglio(nome, valuta, strato), null, 2) + '\n');
    if (errore) throw new Error(errore);
    carica();
    return trovaPortafoglio(cp, nome);
}

// Keys the app does not know (written by hand or by the web app) survive the rewrite.
function cambiaStrato(p, strato) {
    let meta = {};
    try { meta = JSON.parse(A.leggi(`${p.cartella}/portafoglio.json`) || '{}'); } catch { meta = {}; }
    delete meta.rete;
    delete meta.custodia;
    const errore = A.scrivi(`${p.cartella}/portafoglio.json`, JSON.stringify({ ...meta, ...metaPortafoglio(p.nome, 'BTC', strato) }, null, 2) + '\n');
    if (errore) throw new Error(errore);
    carica();
}

// Every save starts from what is on disk right now, so a year Syncthing just brought in is not overwritten
// with the copy this screen loaded earlier.
function cambiaAnno(p, anno, cambia) {
    carica();
    const k = `${p.cartella}/${anno}.csv`;
    const righe = cambia([...(S.file[k]?.righe || [])]).map(m => ({ ...m, conto: p.nome, persona: p.persona }));
    const errore = A.scrivi(k, aCSV(p.tipo, righe));
    if (errore) throw new Error(errore);
    delete S.file[k];
    carica();
}

function portafoglioPer(m) {
    const p = trovaPortafoglio(m.persona, m.conto) || creaPortafoglio(m.persona, m.conto, m.tipo === 'fiat' ? 'EUR' : 'BTC');
    if (p.tipo !== m.tipo) throw new Error(`"${p.nome}" di ${p.persona} è un portafoglio in ${p.valuta === 'BTC' ? 'bitcoin' : 'euro'}`);
    return p;
}

function salvaMovimento(m, vecchio) {
    const p = portafoglioPer(m);
    m.conto = p.nome;
    m.persona = p.persona;
    const anno = m.data.slice(0, 4);
    if (vecchio && (vecchio.data.slice(0, 4) !== anno || vecchio.conto !== p.nome || vecchio.persona !== p.persona)) {
        const pv = trovaPortafoglio(vecchio.persona, vecchio.conto);
        if (pv) cambiaAnno(pv, vecchio.data.slice(0, 4), r => r.filter(x => x.id !== vecchio.id));
    }
    cambiaAnno(p, anno, r => [...r.filter(x => x.id !== m.id), m]);
}

function eliminaMovimento(m) {
    cambiaAnno(trovaPortafoglio(m.persona, m.conto), m.data.slice(0, 4), r => r.filter(x => x.id !== m.id));
}

// ---------- BTC price, the one online thing ----------

async function aggiornaPrezzo() {
    const prova = async (url, leggi) => {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        return leggi(await r.json());
    };
    try {
        let eur;
        try {
            eur = await prova('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur', d => d.bitcoin.eur);
        } catch {
            eur = await prova('https://api.kraken.com/0/public/Ticker?pair=XBTEUR', d => parseFloat(d.result.XXBTZEUR.c[0]));
        }
        if (!Number.isFinite(eur)) return;
        S.prezzo = { eur, ts: Date.now() };
        scriviLocale('bilancio.prezzo', S.prezzo);
        if (S.tab === 'bitcoin' || S.tab === 'home') disegna();
    } catch {
        // offline: the last price stays, with its date
    }
}

// The price on a past day, for valuing sats typed in with that date; one request per day, kept for the session.
const storico = {};
async function prezzoDel(data) {
    if (data === oggi() || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return S.prezzo?.eur ?? null;
    if (data in storico) return storico[data];
    storico[data] = null;
    try {
        const ts = Math.floor(new Date(`${data}T12:00:00Z`).getTime() / 1000);
        const r = await fetch(`https://mempool.space/api/v1/historical-price?currency=EUR&timestamp=${ts}`);
        const d = await r.json();
        const eur = Number(d?.prices?.[0]?.EUR);
        if (eur > 0) storico[data] = eur;
    } catch {
        // offline: the form falls back to today's price
    }
    return storico[data];
}

function prezzoNoto(data) {
    return (data !== oggi() && storico[data]) || S.prezzo?.eur || null;
}

// The sign typed in the amount decides the direction; the switch above only mirrors it, and tapping it flips the sign.
function conSegno(testo, uscita) {
    const t = String(testo || '').trim().replace(/^[-+−]\s*/, '');
    return uscita && t ? `-${t}` : t;
}

// ---------- charts ----------

// Month by month running total, from the first movement to this month.
function cumulataMensile(righe, valore) {
    if (!righe.length) return [];
    const perMese = new Map();
    for (const m of righe) perMese.set(m.data.slice(0, 7), (perMese.get(m.data.slice(0, 7)) || 0) + valore(m));
    const primo = [...perMese.keys()].sort()[0];
    const ultimo = oggi().slice(0, 7) > primo ? oggi().slice(0, 7) : primo;
    const serie = [];
    let tot = 0;
    for (let ym = primo; ym <= ultimo; ym = spostaMese(ym, 1)) {
        tot += perMese.get(ym) || 0;
        serie.push({ x: ym, y: tot });
    }
    return serie;
}

function etichettaMese(ym) {
    const [y, m] = ym.split('-');
    return `${MESI[Number(m) - 1]} ${y.slice(2)}`;
}

function grafico(titolo, serie, { colore = 'var(--fiat)', formato = euroTondo } = {}) {
    if (serie.length < 2) return '';
    const W = 300, H = 110;
    const ys = serie.map(p => p.y);
    const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
    const sy = v => H - ((v - min) / (max - min || 1)) * H;
    const sx = i => (i / (serie.length - 1)) * W;
    const linea = serie.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const zero = sy(0).toFixed(1);
    const ultimo = serie[serie.length - 1];
    // Year boundaries help read a long series.
    const anni = serie.map((p, i) => (p.x.endsWith('-01') && i ? `<line x1="${sx(i).toFixed(1)}" x2="${sx(i).toFixed(1)}" y1="0" y2="${H}" class="anno"/>` : '')).join('');
    return `<div class="scheda grafico">
        <div class="testa-grafico"><small>${esc(titolo)}</small><strong style="color:${colore}">${formato(ultimo.y)}</strong></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            ${anni}
            <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="zero"/>
            <path d="${linea}L${W},${zero}L0,${zero}Z" fill="${colore}" opacity="0.15"/>
            <path d="${linea}" fill="none" stroke="${colore}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="piede-grafico"><span>${etichettaMese(serie[0].x)}</span><span>max ${formato(max)}</span><span>${etichettaMese(ultimo.x)}</span></div>
    </div>`;
}

// ---------- views ----------

function filtroPersona(m) {
    return !S.persona || m.persona === S.persona;
}

// A wallet picked on the bitcoin side must not empty the euro views (and the other way round), where no chip shows it.
function filtroConto(m) {
    return !S.conto || m.conto === S.conto || !portafogliDi(m.tipo).some(p => p.nome === S.conto);
}

function persone() {
    return perUso([...tutti('fiat'), ...tutti('bitcoin')].map(m => m.persona));
}

function chipsPersone(btcStile = false) {
    const lista = persone();
    if (lista.length < 2) return '';
    const c = btcStile ? ' btc' : '';
    return `<div class="chips">
        <button class="chip${c}${S.persona ? '' : ' attivo'}" data-az="persona" data-val="">Tutti</button>
        ${lista.map(p => `<button class="chip${c}${S.persona === p ? ' attivo' : ''}" data-az="persona" data-val="${esc(p)}">${esc(p)}</button>`).join('')}
    </div>`;
}

function filtroContoAttivo(tipo) {
    if (!S.conto || !portafogliDi(tipo).some(p => p.nome === S.conto)) return '';
    return `<div class="chips"><button class="chip attivo${tipo === 'bitcoin' ? ' btc' : ''}" data-az="conto" data-val="">${esc(S.conto)} ✕</button></div>`;
}

function vistaMovimenti() {
    const fiat = tutti('fiat').filter(filtroPersona).filter(filtroConto);
    const q = S.cerca.trim().toLowerCase();
    const elenco = (q
        ? fiat.filter(m => `${m.descrizione} ${m.tipologia} ${m.categoria} ${m.conto}`.toLowerCase().includes(q))
        : fiat.filter(m => m.data.startsWith(S.mese))
    ).sort((a, b) => b.data.localeCompare(a.data));
    const entrate = elenco.filter(m => m.importo > 0).reduce((s, m) => s + m.importo, 0);
    const uscite = elenco.filter(m => m.importo < 0).reduce((s, m) => s + m.importo, 0);
    const sospese = fiat.filter(daClassificare).length;

    let righe = '';
    let giorno = '';
    const mostrate = elenco.slice(0, 400);
    for (const m of mostrate) {
        if (m.data !== giorno) {
            giorno = m.data;
            const tot = elenco.filter(x => x.data === giorno).reduce((s, x) => s + x.importo, 0);
            const etichetta = new Date(`${giorno}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', ...(q ? { year: 'numeric' } : {}) });
            righe += `<div class="giorno"><span>${etichetta}</span><span>${euro(tot)}</span></div>`;
        }
        righe += voce(m);
    }
    if (elenco.length > mostrate.length) righe += `<p class="vuoto">Altri ${elenco.length - mostrate.length} movimenti: restringi la ricerca.</p>`;

    const vista = q ? 'lista' : S.vistaMov;
    const r = vista === 'riepilogo' ? riepilogo() : null;
    return `
        ${q ? '' : `<div class="segmenti pieni">
            <button class="${vista === 'lista' ? 'attivo' : ''}" data-az="vista-mov" data-val="lista">☰ Lista</button>
            <button class="${vista === 'calendario' ? 'attivo' : ''}" data-az="vista-mov" data-val="calendario">▦ Calendario</button>
            <button class="${vista === 'riepilogo' ? 'attivo' : ''}" data-az="vista-mov" data-val="riepilogo">▤ Riepilogo</button>
        </div>`}
        ${r ? r.testa : `${q ? '' : `<div class="navigatore">
            <button data-az="mese" data-val="-1" aria-label="Mese precedente">‹</button>
            <b>${nomeMese(S.mese)}</b>
            <button data-az="mese" data-val="1" aria-label="Mese successivo">›</button>
        </div>`}
        <div class="riassunto">
            <div class="scheda"><small>Entrate</small><strong class="positivo">${euro(entrate)}</strong></div>
            <div class="scheda"><small>Uscite</small><strong class="negativo">${euro(-uscite)}</strong></div>
            <div class="scheda"><small>Saldo</small><strong class="${entrate + uscite < 0 ? 'negativo' : 'positivo'}">${euro(entrate + uscite, true)}</strong></div>
        </div>`}
        <input class="cerca" type="search" placeholder="Cerca in tutti i movimenti…" value="${esc(S.cerca)}" data-campo="cerca">
        ${filtroContoAttivo('fiat')}
        ${chipsPersone()}
        ${sospese ? `<button class="avviso-regole" data-az="regole">${sospese} movimenti da classificare · crea regole ›</button>` : ''}
        ${r ? r.corpo : vista === 'calendario' ? calendario(elenco) : righe || `<p class="vuoto">${q ? 'Nessun movimento trovato.' : 'Nessun movimento in questo mese.<br>Tocca + per aggiungerne uno.'}</p>`}
    `;
}

const COLORI = ['#3b82f6', '#f59e0b', '#ec4899', '#a855f7', '#22c55e', '#f97316', '#06b6d4', '#eab308', '#6366f1', '#f43f5e', '#84cc16', '#94a3b8'];

// Colours follow how often a name is used across all the data, so a category keeps its colour from month to month.
function coloreDi(campo) {
    const nomi = perUso(tutti('fiat').map(m => m[campo] || '—'));
    const mappa = Object.fromEntries(nomi.map((n, i) => [n, COLORI[i % COLORI.length]]));
    return n => mappa[n || '—'] || 'var(--tenue)';
}

function spostaGiorni(d, n) {
    const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return giorno(x);
}
function lunediDi(d) {
    const x = new Date(`${d}T12:00:00`); return spostaGiorni(d, -((x.getDay() + 6) % 7));
}
// The week to open on: this week when looking at the current month, otherwise the month's first week.
function oggiNelMese() {
    return oggi().startsWith(S.mese) ? oggi() : `${S.mese}-01`;
}

function settimana(colore, campo) {
    const inizio = lunediDi(S.calSettimana || oggiNelMese());
    S.calSettimana = inizio;
    const fiat = tutti('fiat').filter(filtroPersona).filter(filtroConto);
    const giorni = Array.from({ length: 7 }, (_, i) => spostaGiorni(inizio, i));
    const fine = giorni[6];
    const delle = fiat.filter(m => m.data >= inizio && m.data <= fine);
    const netto = delle.reduce((t, m) => t + m.importo, 0);
    const fmt = d => new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    const adesso = oggi();
    const righe = giorni.map(d => {
        const sue = delle.filter(m => m.data === d).sort((a, b) => a.importo - b.importo);
        const n = sue.reduce((t, m) => t + m.importo, 0);
        const segno = !sue.length ? '' : n > 0 ? ' entra' : n < 0 ? ' esce' : '';
        return `<div class="giorno-sett${segno}${d === adesso ? ' oggi' : ''}">
            <div class="giorno"><span>${new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric' })}</span><span>${sue.length ? euro(n, true) : ''}</span></div>
            ${sue.map(m => `<div class="striscia" style="--c:${colore(m[campo])}">${voce(m)}</div>`).join('') || '<p class="nota vuota">—</p>'}
        </div>`;
    }).join('');
    return `<div class="navigatore">
            <button data-az="cal-settimana" data-val="-1" aria-label="Settimana precedente">‹</button>
            <b>${fmt(inizio)} – ${fmt(fine)}</b>
            <button data-az="cal-settimana" data-val="1" aria-label="Settimana successiva">›</button>
        </div>
        <p class="nota" style="text-align:center;margin-top:0">Saldo della settimana <b class="${netto < 0 ? 'negativo' : 'positivo'}">${euro(netto, true)}</b></p>
        ${righe}`;
}

function calendario(elenco) {
    const campo = S.calColore === 'categoria' ? 'categoria' : 'persona';
    const colore = coloreDi(campo);
    const scale = `<div class="segmenti pieni due">
            <button class="${S.calScala === 'mese' ? 'attivo' : ''}" data-az="cal-scala" data-val="mese">Mese</button>
            <button class="${S.calScala === 'settimana' ? 'attivo' : ''}" data-az="cal-scala" data-val="settimana">Settimana</button>
        </div>`;
    const sceltaColori = `<div class="chips">
            <span class="nota" style="align-self:center;margin:0">Colori per</span>
            <button class="chip${campo === 'persona' ? ' attivo' : ''}" data-az="cal-colore" data-val="persona">Persona</button>
            <button class="chip${campo === 'categoria' ? ' attivo' : ''}" data-az="cal-colore" data-val="categoria">Categoria</button>
        </div>`;
    if (S.calScala === 'settimana') return scale + sceltaColori + settimana(colore, campo);
    const perGiorno = new Map();
    for (const m of elenco) (perGiorno.get(m.data) || perGiorno.set(m.data, []).get(m.data)).push(m);
    const [y, mm] = S.mese.split('-').map(Number);
    const giorni = new Date(y, mm, 0).getDate();
    const vuoti = (new Date(y, mm - 1, 1).getDay() + 6) % 7; // weeks start on Monday
    const scelto = S.calGiorno.startsWith(S.mese) ? S.calGiorno : [...perGiorno.keys()].sort().pop() || '';
    const adesso = oggi();
    let celle = '<i></i>'.repeat(vuoti);
    for (let d = 1; d <= giorni; d++) {
        const data = `${S.mese}-${String(d).padStart(2, '0')}`;
        const sue = perGiorno.get(data) || [];
        const netto = sue.reduce((t, m) => t + m.importo, 0);
        const punti = sue.slice(0, 6).map(m => `<b style="background:${colore(m[campo])}"></b>`).join('') + (sue.length > 6 ? '<em>+</em>' : '');
        const segno = !sue.length ? '' : netto > 0 ? ' entra' : netto < 0 ? ' esce' : '';
        celle += `<button class="cella${segno}${data === scelto ? ' scelta' : ''}${data === adesso ? ' oggi' : ''}" data-az="cal-giorno" data-val="${data}">
            <span class="num">${d}</span><span class="punti">${punti}</span>
            ${sue.length ? `<span class="netto">${netto > 0 ? '+' : netto < 0 ? '−' : ''}${Math.round(Math.abs(netto))}</span>` : ''}
        </button>`;
    }
    const usati = perUso(elenco.map(m => m[campo] || '—'));
    const delGiorno = (perGiorno.get(scelto) || []);
    const etichetta = scelto ? new Date(`${scelto}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
    return `
        ${scale}
        ${sceltaColori}
        <div class="scheda calendario">
            ${['L', 'M', 'M', 'G', 'V', 'S', 'D'].map(g => `<span class="intesta">${g}</span>`).join('')}
            ${celle}
        </div>
        <div class="legenda">${usati.map(n => `<span><i style="background:${colore(n)}"></i>${esc(n)}</span>`).join('')}
            <span><i style="background:var(--entrata)"></i>entrate</span><span><i style="background:var(--uscita)"></i>uscite</span></div>
        ${scelto ? `<div class="giorno"><span>${etichetta}</span><span>${euro(delGiorno.reduce((t, m) => t + m.importo, 0))}</span></div>
            ${delGiorno.map(voce).join('') || '<p class="vuoto">Nessun movimento in questo giorno.</p>'}` : '<p class="vuoto">Nessun movimento in questo mese.</p>'}
    `;
}

function torta(fette, centro) {
    const tot = fette.reduce((t, f) => t + f.valore, 0);
    if (tot <= 0) return '';
    const R = 42, C = 2 * Math.PI * R;
    let fatto = 0;
    const archi = fette.filter(f => f.valore > 0).map(f => {
        const l = (f.valore / tot) * C;
        const a = `<circle r="${R}" cx="50" cy="50" fill="none" stroke="${f.colore}" stroke-width="14" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-fatto}"/>`;
        fatto += l;
        return a;
    }).join('');
    return `<div class="scheda torta">
        <svg viewBox="0 0 100 100"><g transform="rotate(-90 50 50)">${archi}</g>
            <text x="50" y="47" text-anchor="middle" class="t-piccolo">${esc(centro[0])}</text>
            <text x="50" y="58" text-anchor="middle" class="t-grande">${esc(centro[1])}</text></svg>
        <div class="voci-torta">${fette.map(f => `<div><i style="background:${f.colore}"></i><span>${esc(f.nome)}</span>
            <b>${f.valore > 0 ? Math.round((f.valore / tot) * 100) : 0}%</b><small>${f.testo}</small></div>`).join('')}</div>
    </div>`;
}

function voce(m) {
    const iniziale = (m.tipologia || m.categoria || '?').slice(0, 2);
    const sotto = [m.tipologia, m.conto, persone().length > 1 ? m.persona : ''].filter(Boolean).join(' · ');
    return `<button class="voce" data-az="apri" data-id="${esc(m.id)}" data-tipo="fiat">
        <span class="pallino">${esc(iniziale)}</span>
        <span class="testo"><span class="titolo">${esc(m.descrizione || m.tipologia || 'Movimento')}</span><span class="sotto">${esc(sotto)}</span></span>
        <span class="cifra ${m.importo < 0 ? '' : 'positivo'}">${euro(m.importo, true)}</span>
    </button>`;
}

function riepilogo() {
    const fiat = tutti('fiat').filter(filtroPersona).filter(filtroConto);
    const anno = String(S.anno);
    const dellAnno = fiat.filter(m => m.data.startsWith(anno));
    const entrate = dellAnno.filter(m => m.importo > 0).reduce((s, m) => s + m.importo, 0);
    const uscite = -dellAnno.filter(m => m.importo < 0).reduce((s, m) => s + m.importo, 0);

    const mesi = MESI.map((nome, i) => {
        const ym = `${anno}-${String(i + 1).padStart(2, '0')}`;
        const del = dellAnno.filter(m => m.data.startsWith(ym));
        return {
            ym, nome,
            e: del.filter(m => m.importo > 0).reduce((s, m) => s + m.importo, 0),
            u: -del.filter(m => m.importo < 0).reduce((s, m) => s + m.importo, 0),
        };
    });
    const max = Math.max(1, ...mesi.flatMap(m => [m.e, m.u]));
    const barre = mesi.map(m => `<button class="mese${m.ym === S.mese ? ' scelto' : ''}" data-az="scegli-mese" data-val="${m.ym}">
        <div class="coppia"><i class="e" style="height:${(m.e / max) * 100}%"></i><i class="u" style="height:${(m.u / max) * 100}%"></i></div>
        <span>${m.nome}</span></button>`).join('');

    const periodo = S.vistaCat === 'mese' && S.mese.startsWith(anno) ? S.mese : anno;
    const spese = fiat.filter(m => m.importo < 0 && m.data.startsWith(periodo));
    const totSpese = -spese.reduce((s, m) => s + m.importo, 0);
    const perCat = new Map();
    for (const m of spese) {
        const c = m.categoria || m.tipologia || 'Altro';
        const g = perCat.get(c) || { tot: 0, tip: new Map() };
        g.tot -= m.importo;
        const t = m.tipologia || '—';
        g.tip.set(t, (g.tip.get(t) || 0) - m.importo);
        perCat.set(c, g);
    }
    const ordinate = [...perCat.entries()].sort((a, b) => b[1].tot - a[1].tot);
    const maxCat = ordinate[0]?.[1].tot || 1;
    const categorie = ordinate.map(([c, g]) => {
        const aperta = S.catAperta === c;
        const tip = aperta ? `<div class="sottocat">${[...g.tip.entries()].sort((a, b) => b[1] - a[1]).map(([t, v]) => `
            <div class="riga-cat"><div class="nome"><span>${esc(t)}</span><span>${euro(v)}</span></div>
            <div class="barra"><i style="width:${(v / g.tot) * 100}%"></i></div></div>`).join('')}</div>` : '';
        return `<button class="riga-cat" data-az="cat" data-val="${esc(c)}">
            <div class="nome"><span>${aperta ? '▾' : '▸'} ${esc(c)}</span><span>${euro(g.tot)} <small style="color:var(--tenue)">${Math.round((g.tot / totSpese) * 100)}%</small></span></div>
            <div class="barra"><i style="width:${(g.tot / maxCat) * 100}%"></i></div>
        </button>${tip}`;
    }).join('');

    // Monthly savings this year, a running total: whether the year is ending ahead or behind.
    const risparmioAnno = [];
    let r = 0;
    for (const m of mesi) {
        if (m.ym > oggi().slice(0, 7)) break;
        r += m.e - m.u;
        risparmioAnno.push({ x: m.ym, y: r });
    }

    const testa = `
        <div class="navigatore">
            <button data-az="anno" data-val="-1" aria-label="Anno precedente">‹</button>
            <b>${anno}</b>
            <button data-az="anno" data-val="1" aria-label="Anno successivo">›</button>
        </div>
        <div class="riassunto">
            <div class="scheda"><small>Entrate</small><strong class="positivo">${euro(entrate)}</strong></div>
            <div class="scheda"><small>Uscite</small><strong class="negativo">${euro(uscite)}</strong></div>
            <div class="scheda"><small>Risparmio</small><strong class="${entrate - uscite < 0 ? 'negativo' : 'positivo'}">${euro(entrate - uscite, true)}</strong></div>
        </div>`;
    const corpo = `
        <div class="scheda"><div class="barre">${barre}</div></div>
        ${grafico(`Risparmio accumulato nel ${anno}`, risparmioAnno, { colore: 'var(--entrata)' })}
        ${grafico('Saldo dei movimenti, dal primo', cumulataMensile(fiat, m => m.importo))}
        <div class="sezione">
            <span>Spese per categoria · ${periodo === anno ? anno : nomeMese(periodo)}</span>
            <span class="segmenti">
                <button class="${S.vistaCat === 'mese' ? 'attivo' : ''}" data-az="vista-cat" data-val="mese">Mese</button>
                <button class="${S.vistaCat === 'anno' ? 'attivo' : ''}" data-az="vista-cat" data-val="anno">Anno</button>
            </span>
        </div>
        ${categorie || '<p class="vuoto">Nessuna spesa in questo periodo.</p>'}
    `;
    return { testa, corpo };
}

// One bubble per period: its area is the euro spent, its height the average price paid, its colour how far today's
// price is from it. The orange ring is what the same coins are worth today, on the same scale.
function grafoBolle(acquisti, p, medio) {
    if (!acquisti.length) return '';
    const per = S.btcPeriodo;
    const gruppi = new Map();
    for (const m of acquisti) {
        const k = chiavePeriodo(m.data, per);
        const g = gruppi.get(k) || { k, euro: 0, btc: 0, primo: m.data, ultimo: m.data };
        g.euro += m.euro; g.btc += m.bitcoin;
        if (m.data < g.primo) g.primo = m.data;
        if (m.data > g.ultimo) g.ultimo = m.data;
        gruppi.set(k, g);
    }
    const lista = [...gruppi.values()].sort((a, b) => a.k.localeCompare(b.k));
    for (const g of lista) { g.prezzo = g.euro / g.btc; g.oggi = p ? g.btc * p : null; g.pct = p ? (p / g.prezzo - 1) * 100 : null; }
    const W = 340, H = 230, mx = 10, alto = 14, basso = 22;
    const t = d => new Date(`${d}T12:00:00`).getTime();
    const x0 = t(lista[0].primo), x1 = Math.max(t(lista.at(-1).ultimo), x0 + 864e5);
    const prezzi = [...lista.map(g => g.prezzo), ...(p ? [p] : []), medio];
    let y0 = Math.min(...prezzi), y1 = Math.max(...prezzi);
    const pad = (y1 - y0) * 0.12 || y1 * 0.1;
    y0 = Math.max(0, y0 - pad); y1 += pad;
    const X = g => mx + 18 + ((t(g.primo) + t(g.ultimo)) / 2 - x0) / (x1 - x0) * (W - 2 * mx - 36);
    const Y = v => alto + (1 - (v - y0) / (y1 - y0)) * (H - alto - basso);
    const maxV = Math.max(...lista.map(g => Math.max(g.euro, g.oggi || 0)));
    const rMax = Math.min(26, 220 / Math.sqrt(lista.length + 4));
    const R = v => Math.max(2.2, Math.sqrt(v / maxV) * rMax);
    const colorePct = pct => pct === null ? 'var(--fiat)' : pct >= 0 ? 'var(--entrata)' : 'var(--uscita)';
    const scelto = gruppi.get(S.btcScelto);
    const bolle = lista.map(g => `<g data-az="btc-scegli" data-val="${g.k}" class="bolla${g === scelto ? ' scelta' : ''}">
        ${g.oggi ? `<circle cx="${X(g)}" cy="${Y(g.prezzo)}" r="${R(g.oggi)}" class="anello"/>` : ''}
        <circle cx="${X(g)}" cy="${Y(g.prezzo)}" r="${R(g.euro)}" fill="${colorePct(g.pct)}" class="pieno"/>
    </g>`).join('');
    const linea = (v, cls, testo) => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" class="${cls}"/><text x="${W - 2}" y="${Y(v) - 3}" text-anchor="end" class="t-linea ${cls}">${testo}</text>`;
    const anni = [];
    for (let a = Number(lista[0].primo.slice(0, 4)) + 1; a <= Number(lista.at(-1).ultimo.slice(0, 4)); a++) {
        const xa = mx + 18 + (t(`${a}-01-01`) - x0) / (x1 - x0) * (W - 2 * mx - 36);
        anni.push(`<line x1="${xa}" x2="${xa}" y1="${alto}" y2="${H - basso}" class="anno"/><text x="${xa}" y="${H - 6}" text-anchor="middle" class="t-asse">${a}</text>`);
    }
    const k = n => `${Math.round(n / 1000)}k`;
    const tot = lista.reduce((a, g) => ({ euro: a.euro + g.euro, oggi: a.oggi + (g.oggi || 0) }), { euro: 0, oggi: 0 });
    const dett = scelto || null;
    const riga = g => `<b>${esc(etichettaPeriodo(g.k, per))}</b> · investiti ${euro(g.euro)} a € ${Math.round(g.prezzo).toLocaleString('it-IT')} · ${btc(g.btc)}${g.oggi !== null ? ` · oggi ${euro(g.oggi)} <b class="${g.pct < 0 ? 'negativo' : 'positivo'}">${g.pct >= 0 ? '+' : ''}${Math.round(g.pct)}%</b>` : ''}`;
    const perAnno = new Map();
    for (const g of lista) {
        const a = g.primo.slice(0, 4), x = perAnno.get(a) || { euro: 0, btc: 0 };
        x.euro += g.euro; x.btc += g.btc; perAnno.set(a, x);
    }
    const tabella = [...perAnno].sort().reverse().map(([a, x]) => {
        const oggi = p ? x.btc * p : null, roi = oggi !== null ? (oggi / x.euro - 1) * 100 : null;
        return `<tr><td>${a}</td><td>${euroTondo(x.euro)}</td><td>${oggi !== null ? euroTondo(oggi) : '—'}</td><td class="${roi === null ? '' : roi < 0 ? 'negativo' : 'positivo'}">${roi === null ? '—' : `${roi >= 0 ? '+' : ''}${Math.round(roi)}%`}</td></tr>`;
    }).join('');
    return `<div class="scheda grafico bolle">
        <div class="testa-grafico"><small>Acquisti: quanto e a che prezzo</small>
            <strong class="${tot.oggi && tot.oggi < tot.euro ? 'negativo' : 'positivo'}">${p ? `${tot.oggi >= tot.euro ? '+' : ''}${Math.round((tot.oggi / tot.euro - 1) * 100)}%` : ''}</strong></div>
        <svg viewBox="0 0 ${W} ${H}">
            ${anni.join('')}
            <text x="2" y="${alto + 8}" class="t-asse">€ ${k(y1)}</text><text x="2" y="${H - basso - 2}" class="t-asse">€ ${k(y0)}</text>
            ${linea(medio, 'pareggio', `medio € ${k(medio)}`)}
            ${p ? linea(p, 'attuale', `oggi € ${k(p)}`) : ''}
            ${bolle}
        </svg>
        <p class="nota dett-bolla">${dett ? riga(dett) : 'Tocca una bolla. Grandezza = euro investiti, anello arancio = valore oggi, verde/rosso = sopra o sotto il prezzo di oggi.'}</p>
        <table class="roi"><thead><tr><th>Anno</th><th>Investito</th><th>Oggi</th><th>ROI</th></tr></thead><tbody>${tabella}</tbody></table>
    </div>`;
}

// Sats gained or spent in each period, not added up: early months with cheap coins show as the tall bars they were.
function barreSats(tx) {
    const per = S.btcPeriodo;
    const somme = new Map();
    for (const m of tx) { const k = chiavePeriodo(m.data, per); somme.set(k, (somme.get(k) || 0) + m.bitcoin); }
    if (!somme.size) return '';
    const chiavi = [...somme.keys()].sort();
    let elenco = [];
    for (let k = chiavi[0]; k <= chiavi.at(-1); k = seguente(k, per)) elenco.push(k);
    elenco = elenco.slice(-({ mese: 36, trimestre: 16, anno: 12 }[per]));
    const max = Math.max(1e-8, ...elenco.map(k => Math.abs(somme.get(k) || 0)));
    const ciSonoUscite = elenco.some(k => (somme.get(k) || 0) < 0);
    const W = 340, H = 120, zero = ciSonoUscite ? H * 0.62 : H - 2, scala = ciSonoUscite ? Math.max(zero, H - zero) : zero;
    const lw = W / elenco.length;
    const barre = elenco.map((k, i) => {
        const v = somme.get(k) || 0, h = Math.abs(v) / max * (scala - 4);
        return `<rect x="${i * lw + lw * 0.15}" y="${v >= 0 ? zero - h : zero}" width="${lw * 0.7}" height="${Math.max(h, v ? 1 : 0)}" fill="${v >= 0 ? 'var(--btc)' : 'var(--uscita)'}" rx="1.5"/>`;
    }).join('');
    const tot = elenco.reduce((a, k) => a + (somme.get(k) || 0), 0);
    return `<div class="scheda grafico">
        <div class="testa-grafico"><small>Sats per ${per === 'mese' ? 'mese' : per === 'trimestre' ? 'trimestre' : 'anno'}</small><strong class="arancio">${btc(tot)}</strong></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${barre}<line x1="0" x2="${W}" y1="${zero}" y2="${zero}" class="zero"/></svg>
        <div class="piede-grafico"><span>${esc(etichettaPeriodo(elenco[0], per))}</span><span>max ${btc(max)}</span><span>${esc(etichettaPeriodo(elenco.at(-1), per))}</span></div>
    </div>`;
}

function calcoliBitcoin() {
    const tx = tutti('bitcoin').filter(filtroPersona).filter(filtroConto).sort((a, b) => b.data.localeCompare(a.data));
    const detenuti = tx.reduce((s, m) => s + m.bitcoin, 0);
    const suLN = m => trovaPortafoglio(m.persona, m.conto)?.rete === 'LN';
    const ln = tx.filter(suLN).reduce((s, m) => s + m.bitcoin, 0);
    const netti = tx.reduce((s, m) => s + m.euro, 0);
    // A purchase is euro turned into on-chain bitcoin; sats received on Lightning are payments, not buys.
    const acquisti = tx.filter(m => m.bitcoin > 0 && m.euro > 0 && !suLN(m));
    const btcComprati = acquisti.reduce((s, m) => s + m.bitcoin, 0);
    // Total euro over total bitcoin: each purchase weighs as much as it cost.
    const medio = btcComprati > 0 ? acquisti.reduce((s, m) => s + m.euro, 0) / btcComprati : 0;
    const p = S.prezzo?.eur;
    const valore = p ? detenuti * p : null;
    return { tx, detenuti, ln, onchain: detenuti - ln, netti, acquisti, medio, p, valore, guadagno: valore !== null ? valore - netti : null };
}

function vistaBitcoin() {
    const { tx, detenuti, ln, onchain, netti, acquisti, medio, p, valore, guadagno } = calcoliBitcoin();
    const quando = S.prezzo ? new Date(S.prezzo.ts) : null;
    const etichettaPrezzo = !quando ? 'Prezzo non ancora scaricato'
        : Date.now() - S.prezzo.ts < 10 * 60 * 1000 ? `aggiornato alle ${quando.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
        : `ultimo prezzo del ${quando.toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;

    const perPersona = perUso(tutti('bitcoin').map(m => m.persona)).map(nome => {
        const b = tutti('bitcoin').filter(m => m.persona === nome).filter(filtroConto).reduce((s, m) => s + m.bitcoin, 0);
        return `<div class="riga-cat"><div class="nome"><span>${esc(nome)}</span><span>${btc(b)}</span></div></div>`;
    }).join('');

    const lista = tx.slice(0, 300).map(m => `<button class="voce" data-az="apri" data-id="${esc(m.id)}" data-tipo="bitcoin">
        <span class="pallino" style="color:var(--btc)">₿</span>
        <span class="testo"><span class="titolo">${btc(m.bitcoin)}</span>
        <span class="sotto">${new Date(`${m.data}T12:00:00`).toLocaleDateString('it-IT')} · ${esc(m.persona)}${portafogliDi('bitcoin').length > 1 ? ` · ${esc(m.conto)}` : ''}${m.prezzo ? ` · € ${Math.round(m.prezzo).toLocaleString('it-IT')}/BTC` : ''}</span></span>
        <span class="cifra">${euro(m.euro)}</span>
    </button>`).join('');

    const visibili = [...S.portafogli.values()].filter(x => x.tipo === 'bitcoin' && (!S.persona || x.persona === S.persona) && (!S.conto || x.nome === S.conto));
    const portLN = visibili.filter(x => x.rete === 'LN');
    const portOn = visibili.filter(x => x.rete !== 'LN');
    const titolare = (S.persona || pref.io || '').toUpperCase();
    // Each wallet's own balance on the card, hiding the emptied ones as Conti does.
    const carta = (classe, titolo, saldo, wallet) => `<div class="carta ${classe}">
            <div class="carta-testa"><span>${titolo}</span><i class="carta-chip"></i></div>
            <strong>${btc(saldo)}</strong>
            <span class="carta-euro">${p ? `≈ ${euro(saldo * p)}` : '&nbsp;'}</span>
            <div class="carta-piede">
                <span>${esc(titolare)}</span>
                <span class="carta-wallet">${wallet.map(x => [x, tutti('bitcoin').filter(m => m.persona === x.persona && m.conto === x.nome).reduce((s, m) => s + m.bitcoin, 0)])
                    .filter(([, b]) => Math.abs(b) >= 5e-9).sort((a, b) => b[1] - a[1])
                    .map(([x, b]) => `<button data-az="apri-conto" data-val="${esc(x.nome)}" data-persona="${esc(x.persona)}">${esc(x.nome)} ${btc(b)}</button>`).join('')}</span>
            </div>
        </div>`;

    return `
        <div class="totale-btc">
            <small>Saldo totale</small>
            <strong>${btc(detenuti)}</strong>
            <span>${valore !== null ? `≈ ${euro(valore)}` : ''}</span>
        </div>
        ${portOn.length || !portLN.length ? carta('onchain', '₿ Onchain', onchain, portOn) : ''}
        ${portLN.length ? carta('ln', '⚡ Lightning', ln, portLN) : ''}
        <div class="griglia2">
            <div class="scheda"><small>Investiti</small><strong>${euro(netti)}</strong></div>
            <div class="scheda"><small>Guadagno</small><strong class="${guadagno === null ? '' : guadagno < 0 ? 'negativo' : 'positivo'}">${guadagno === null ? '—' : `${euro(guadagno, true)}${netti > 0 ? ` (${Math.round((guadagno / netti) * 100)}%)` : ''}`}</strong></div>
            <div class="scheda"><small>Prezzo medio</small><strong>${medio ? `€ ${Math.round(medio).toLocaleString('it-IT')}` : '—'}</strong></div>
            <button class="scheda" data-az="prezzo" style="text-align:left"><small>Prezzo ↻</small><strong>${p ? `€ ${Math.round(p).toLocaleString('it-IT')}` : '—'}</strong></button>
        </div>
        <p class="nota">${etichettaPrezzo}</p>
        ${filtroContoAttivo('bitcoin')}
        ${chipsPersone(true)}
        <div class="segmenti pieni">
            ${[['mese', 'Mese'], ['trimestre', 'Trimestre'], ['anno', 'Anno']].map(([k, n]) => `<button class="${S.btcPeriodo === k ? 'attivo' : ''}" data-az="btc-periodo" data-val="${k}">${n}</button>`).join('')}
        </div>
        ${grafoBolle(acquisti, p, medio)}
        ${barreSats(tx)}
        ${!S.persona && perPersona ? `<div class="sezione"><span>Per persona</span></div><div class="scheda">${perPersona}</div>` : ''}
        <div class="sezione"><span>Movimenti</span></div>
        ${lista || '<p class="vuoto">Nessun acquisto. Tocca + per aggiungerne uno.</p>'}
    `;
}

// ---------- the funds pyramid (Ortix) ----------

// Top to bottom: the less it holds, the closer to the tip and the easier to spend.
const STRATI = {
    ln: { articoli: ['ln', 'canali'], nome: 'Lightning', icona: '⚡', colore: '#facc15', ruolo: 'Punta · spese di tutti i giorni', uso: 'Caffè, spesa, micropagamenti', sicurezza: 'Bassa: pochi fondi, ricaricati dal livello hot', esempi: 'Phoenix, Breez, Zeus', concetto: 'Azione immediata' },
    hot: { articoli: ['hot', 'wallet'], nome: 'Hot wallet', icona: '🔥', colore: '#f97316', ruolo: 'Mezzo · medio termine', uso: 'Risparmi da usare entro mesi, acquisti importanti', sicurezza: 'Media: telefono o PC, passphrase e backup cifrato', esempi: 'BlueWallet, Sparrow, Nunchuk', concetto: 'Sovranità operativa' },
    cold: { articoli: ['cold', 'seed'], nome: 'Cold wallet', icona: '❄', colore: '#22d3ee', ruolo: 'Base · il patrimonio', uso: 'HODL, risparmio di lungo periodo, eredità', sicurezza: 'Massima: chiavi offline, seed su acciaio', esempi: 'SeedSigner, Coldcard, Airgap Vault', concetto: 'Asset immutabile' },
    fiat: { articoli: ['cuscinetto'], nome: 'Euro', icona: '€', colore: '#3b82f6', ruolo: 'Liquidità in euro', uso: 'Bollette, spese correnti, cuscinetto per le emergenze', sicurezza: 'In custodia della banca', esempi: 'Conti correnti, contanti', concetto: 'Cuscinetto' },
};
const ORDINE_BTC = ['ln', 'hot', 'cold'];

// The app says the minimum and sends to the Ortix articles for the rest.
const ORTIX = 'https://ortix.vercel.app/';
const ARTICOLI = {
    piramide: ['La piramide dei fondi', 'bitcoin/guide-e-consigli/gestire-i-bitcoin-in-modo-intelligente'],
    profili: ['I profili della piramide', 'bitcoin/guide-e-consigli/i-profili-della-piramide-dei-fondi'],
    cold: ['Cold wallet', 'bitcoin/definizioni/blockchain/cold-wallet'],
    seed: ['Seed phrase', 'bitcoin/definizioni/blockchain/seed-phrase'],
    hot: ['Hot wallet', 'bitcoin/definizioni/blockchain/hot-wallet'],
    wallet: ['Scegliere il wallet giusto', 'bitcoin/guide-e-consigli/3-come-scegliere-il-wallet-giusto-per-te'],
    ln: ['Lightning Network', 'bitcoin/lightning-network/lightning-network'],
    canali: ['Canali di pagamento', 'bitcoin/definizioni/lightning/canale-di-pagamento'],
    lnSovrano: ['Sovrano su Lightning', 'bitcoin/lightning-network/00-come-essere-sovrano-su-ln-step-by-step'],
    cuscinetto: ['Il cuscinetto in euro', 'bitcoin/guide-e-consigli/il-cuscinetto-in-euro'],
    pac: ['Il PAC: evita il trading', 'bitcoin/filosofia/evita-il-trading'],
    iniziare: ['Bitcoin: dove iniziare', 'bitcoin/bitcoin-dove-iniziare'],
    morto: ['Bitcoin è morto (e risorto)', 'bitcoin/filosofia/bitcoin-e-morto-e-risorto'],
    vivere: ['Vivere in Bitcoin', 'bitcoin/guide-e-consigli/vivere-in-bitcoin'],
    syncthing: ['Syncthing', 'ortix/storage/syncthing'],
    backup: ['Backup sovrano con Syncthing', 'ortix/storage/backup-sovrano-con-3-dispositivi-e-syncthing'],
    cloud: ['Perché non un cloud centralizzato', 'ortix/storage/perche-non-dovresti-usare-un-cloud-centralizzato'],
};

function approfondisci(...chiavi) {
    return `<div class="ortix"><small>📖 Approfondisci su Ortix</small>${chiavi.map(k =>
        `<a href="${ORTIX}${ARTICOLI[k][1]}/" target="_blank" rel="noopener">${esc(ARTICOLI[k][0])} ›</a>`).join('')}</div>`;
}
const BARATTOLO_P2P = 'https://barattolo.store/p2p';

function acquistaP2P() {
    return `<a class="bottone btc acquista-p2p" href="${BARATTOLO_P2P}" target="_blank" rel="noopener">🏺 Acquista Bitcoin P2P</a>
        <p class="nota piccola">Su Barattolo, senza exchange: euro e sats passano direttamente tra persone.</p>`;
}
const TUTTI_STRATI = ['ln', 'hot', 'cold', 'fiat'];
// Past these a layer stops doing its job: a hot wallet is money at risk, and Lightning channels holding
// more than this are a chore to keep balanced. Lightning also never takes more than a tenth of a small stack.
const HOT_MAX = 10, LN_MAX = 1000, LN_QUOTA_MAX = 0.1;
const NON_CONSIGLIO = 'Non è un consiglio finanziario: è un esempio di come organizzare i fondi, da adattare alla tua situazione.';

const SETUP = {
    nocoiner: {
        articoli: ['iniziare', 'cuscinetto'],
        nome: 'No coiner', icona: '🏦', hot: 0, ln: 0, mesi: 3, fiatMax: false, soloFiat: true,
        breve: 'Nessun bitcoin: la piramide è tutta in euro.',
        per: 'Chi non ha bitcoin, o non li ha ancora registrati.',
        regole: ['La piramide ha un solo piano: gli euro.',
            'Tre mesi di spese da parte sono il primo cuscinetto, bitcoin o no.',
            'Per cominciare con i bitcoin c’è il profilo 🌱 Alle prime armi: un PAC verso un cold wallet.'],
    },
    inizio: {
        articoli: ['pac', 'cold'],
        nome: 'Alle prime armi', icona: '🌱', hot: 0, ln: 0, mesi: 3, fiatMax: false,
        breve: 'Un PAC verso il cold wallet: si costruisce la base, senza spendere.',
        per: 'Chi ha appena iniziato: meno di sei mesi di acquisti, o pochi bitcoin rispetto agli euro.',
        regole: ['Tutti i bitcoin nel ❄ cold wallet: niente hot e niente Lightning finché la base non c’è.',
            'Un PAC (piano di accumulo): la stessa cifra ogni mese, scelta dentro quello che risparmi, qualunque sia il prezzo.',
            'Gli euro restano dove sono: è il PAC a spostarli, un mese alla volta. Tre mesi di spese non si toccano.',
            'Gli altri piani della piramide arrivano dopo, quando la base è solida.'],
    },
    ortix: {
        articoli: ['piramide', 'hot'],
        nome: 'Piramide Ortix', icona: '△', hot: 10, ln: 300, mesi: 3, fiatMax: false,
        breve: 'La piramide classica: base cold, poco hot, una punta Lightning per spendere.',
        per: 'Chi accumula da un po’ e vuole tenere i fondi in ordine.',
        regole: ['❄ Cold wallet: il grosso, con le chiavi offline.',
            `🔥 Hot wallet: al massimo il ${HOT_MAX}%, perché sono fondi più esposti.`,
            '⚡ Lightning: qualche centinaio di euro per spendere, mai più di 1.000 €.',
            'Tre mesi di spese in euro.'],
    },
    negativo: {
        articoli: ['morto', 'pac'],
        nome: 'In perdita', icona: '🧊', hot: 5, ln: 100, mesi: 6, fiatMax: false,
        breve: 'Sotto il prezzo medio: si continua ad accumulare con gli euro che avanzano, spendendo poco.',
        per: 'Chi oggi ha bitcoin che valgono meno di quanto li ha pagati.',
        regole: ['Si continua ad accumulare solo con gli euro oltre il cuscinetto: i soldi delle spese non si toccano.',
            'Cuscinetto più largo, sei mesi: il periodo si attraversa senza dover vendere.',
            'Spese sotto la media: si tira avanti spendendo il meno possibile.',
            'Hot e Lightning al minimo.'],
    },
    massimalista: {
        articoli: ['vivere', 'cuscinetto'],
        nome: 'Massimalista', icona: '🟠', hot: 5, ln: 1000, mesi: 1, fiatMax: true,
        breve: 'In euro al massimo un mese di spese, tutto il resto in bitcoin.',
        per: 'Chi ha scelto di risparmiare solo in bitcoin.',
        regole: ['Le spese mensili si stimano dai movimenti degli ultimi 12 mesi.',
            'In euro al massimo un mese di spese: quello che avanza è un candidato a diventare bitcoin.',
            'Lightning pieno, fino a 1.000 €, per pagare in sats.',
            'Hot wallet al 5%.'],
    },
    positivo: {
        articoli: ['vivere', 'lnSovrano'],
        nome: 'Vivere in bitcoin', icona: '🚀', hot: 10, ln: 1000, mesi: 2, fiatMax: false,
        breve: 'Molto in guadagno: la piramide completa, spendendo in sats dalla punta.',
        per: 'Chi ha bitcoin che valgono almeno il doppio di quanto li ha pagati.',
        regole: ['La piramide completa: cold alla base, hot al 10% per i mesi a venire, Lightning fino a 1.000 €.',
            'Le spese di tutti i giorni si pagano dalla punta ⚡, che si ricarica dall’hot wallet.',
            'Pochi euro, due mesi di spese: si vive da bitcoiner.',
            'Il cold wallet non si tocca.'],
    },
};
const MIO = { nome: 'Personalizzato', icona: '✎', breve: 'Obiettivi scelti a mano.' };
// Kept beside the data like the rules, so every phone shows the same targets.
const FILE_PIRAMIDE = 'piramide.json';
// Money moved, not earned or spent: buying bitcoin out of the bank account is not a cost of living.
const NON_SPESA = /bitcoin|btc|investiment|giroconto|trasferiment|risparmi/i;

const tra = (x, min, max, def) => (Number.isFinite(Number(x)) && x !== '' && x !== null ? Math.min(max, Math.max(min, Number(x))) : def);

// A named profile always means its own numbers; only the hand-made one reads them from the file.
function cfgDi(setup, c = {}) {
    const base = SETUP[setup];
    if (base) return { setup, hot: base.hot, ln: base.ln, mesi: base.mesi, fiatMax: base.fiatMax, soloFiat: !!base.soloFiat };
    const d = SETUP.ortix;
    return {
        setup,
        hot: tra(c.hot ?? c.obiettivi?.hot, 0, HOT_MAX, d.hot),
        ln: tra(c.ln, 0, LN_MAX, d.ln),
        mesi: tra(c.mesi, 1, 24, d.mesi),
        fiatMax: typeof c.fiatMax === 'boolean' ? c.fiatMax : d.fiatMax,
        soloFiat: false,
    };
}

// The profile picked by hand, or null when the app follows the funds.
function configPiramide() {
    let c = {};
    try { c = JSON.parse(A.leggi(FILE_PIRAMIDE) || '{}'); } catch { c = {}; }
    const setup = SETUP[c.setup] || c.setup === 'mio' ? c.setup : null;
    return setup ? cfgDi(setup, c) : null;
}

function salvaConfigPiramide(c) {
    const errore = A.scrivi(FILE_PIRAMIDE, JSON.stringify(c, null, 2) + '\n');
    if (errore) throw new Error(errore);
}

function usaSetup(k) {
    if (k === 'auto') { salvaConfigPiramide({}); return; }
    const s = SETUP[k];
    salvaConfigPiramide({ setup: k, hot: s.hot, ln: s.ln, mesi: s.mesi, fiatMax: s.fiatMax });
}

// Averages of the last twelve full months that have any movement, so a ledger started in March is not diluted.
function medieMensili() {
    const ora = oggi().slice(0, 7), dal = spostaMese(ora, -12);
    const nel = tutti('fiat').filter(filtroPersona).filter(m => { const ym = m.data.slice(0, 7); return ym >= dal && ym < ora; });
    const mesi = new Set(nel.map(m => m.data.slice(0, 7))).size;
    const vere = nel.filter(m => !NON_SPESA.test(`${m.tipologia} ${m.categoria}`));
    const spese = -vere.filter(m => m.importo < 0).reduce((s, m) => s + m.importo, 0);
    const entrate = vere.filter(m => m.importo > 0).reduce((s, m) => s + m.importo, 0);
    return mesi ? { spesa: spese / mesi, risparmio: (entrate - spese) / mesi } : { spesa: 0, risparmio: 0 };
}

// Floors from the smallest amount at the tip to the largest at the base, each with an area proportional to its
// share: the area above a height grows with its square, so the cumulative share sets each floor's edge.
function pianiPerImporto(valori, cima, alto) {
    const voci = TUTTI_STRATI.filter(k => valori[k] > 0).sort((a, b) => valori[a] - valori[b] || TUTTI_STRATI.indexOf(a) - TUTTI_STRATI.indexOf(b));
    const tot = voci.reduce((t, k) => t + valori[k], 0);
    let c = 0;
    return voci.map(k => {
        const y1 = cima + alto * Math.sqrt(c / tot);
        c += valori[k];
        return { k, y1, y2: cima + alto * Math.sqrt(c / tot), quota: valori[k] / tot };
    });
}

function trapezio(cx, mezza, cima, alto, y1, y2) {
    const w = y => (mezza * (y - cima)) / alto;
    return `${cx - w(y1)},${y1} ${cx + w(y1)},${y1} ${cx + w(y2)},${y2} ${cx - w(y2)},${y2}`;
}

function saldoDi(p) {
    return tutti(p.tipo).filter(m => m.conto === p.nome && m.persona === p.persona).reduce((s, m) => s + (p.tipo === 'fiat' ? m.importo : m.bitcoin), 0);
}

function statoPiramide() {
    const scelto = configPiramide();
    const prezzo = S.prezzo?.eur || null;
    const strati = Object.fromEntries(Object.keys(STRATI).map(k => [k, { valore: 0, wallet: [] }]));
    for (const p of S.portafogli.values()) {
        if (S.persona && p.persona !== S.persona) continue;
        const saldo = saldoDi(p);
        strati[p.strato].wallet.push({ p, saldo });
        // An overdrawn account holds nothing, it does not cancel what the others hold.
        strati[p.strato].valore += Math.max(0, saldo);
    }
    for (const s of Object.values(strati)) s.wallet.sort((a, b) => b.saldo - a.saldo);
    const btcTot = ORDINE_BTC.reduce((t, k) => t + strati[k].valore, 0);
    const { spesa, risparmio } = medieMensili();

    const tx = tutti('bitcoin').filter(filtroPersona);
    const investiti = tx.reduce((t, m) => t + m.euro, 0);
    const guadagnoPct = prezzo && investiti > 0 ? ((btcTot * prezzo) / investiti - 1) * 100 : null;
    const mesiAcquisto = new Set(tx.filter(m => m.bitcoin > 0 && m.euro > 0).map(m => m.data.slice(0, 7))).size;
    const fiat = strati.fiat.valore;
    const quotaBtc = prezzo && fiat + btcTot * prezzo > 0 ? (btcTot * prezzo) / (fiat + btcTot * prezzo) : null;
    // The profile the funds look like today, from how they are split first and how they have done second.
    const consigliato = btcTot <= 0 ? 'nocoiner'
        : mesiAcquisto < 6 || (quotaBtc !== null && quotaBtc < 0.1) ? 'inizio'
        : guadagnoPct !== null && guadagnoPct < 0 ? 'negativo'
        : quotaBtc !== null && quotaBtc >= 0.85 && spesa > 0 && fiat <= spesa * 1.5 ? 'massimalista'
        : guadagnoPct !== null && guadagnoPct >= 100 ? 'positivo' : 'ortix';
    const auto = !scelto;
    const cfg = scelto || cfgDi(consigliato);

    // Targets are amounts, not fixed shares: Lightning is a few hundred euro whatever the stack, the hot
    // wallet a capped slice of it, the cold wallet everything else.
    const lnEuro = prezzo && !cfg.soloFiat ? Math.min(cfg.ln, LN_MAX, btcTot * prezzo * LN_QUOTA_MAX) : 0;
    strati.ln.obiettivoEuro = lnEuro;
    strati.ln.target = prezzo ? lnEuro / prezzo : 0;
    strati.hot.target = (btcTot * cfg.hot) / 100;
    strati.cold.target = cfg.soloFiat ? 0 : Math.max(0, btcTot - strati.hot.target - strati.ln.target);
    for (const k of ORDINE_BTC) {
        const s = strati[k];
        s.obiettivo = btcTot > 0 ? (s.target / btcTot) * 100 : 0;
        s.quota = btcTot > 0 ? (s.valore / btcTot) * 100 : 0;
        s.riempito = s.target > 0 ? s.valore / s.target : s.valore > 0 ? 2 : 0;
    }
    const cuscinetto = spesa * cfg.mesi;
    const f = strati.fiat;
    f.mesiCoperti = spesa > 0 ? f.valore / spesa : null;
    f.riempito = cfg.soloFiat ? (f.valore > 0 ? 1 : 0) : cuscinetto > 0 ? f.valore / cuscinetto : f.valore > 0 ? 1 : 0;
    f.troppo = !cfg.soloFiat && cuscinetto > 0 && (cfg.fiatMax ? f.valore > cuscinetto * 1.05 + 50 : f.valore > cuscinetto * 1.25 + 200);

    // 100% when every layer holds exactly its share, 0% when all the bitcoin sits in a layer meant to be empty.
    const allineamento = btcTot > 0 && !cfg.soloFiat ? 100 - ORDINE_BTC.reduce((t, k) => t + Math.abs(strati[k].quota - strati[k].obiettivo), 0) / 2 : null;
    return { cfg, auto, prezzo, strati, btcTot, spesa, risparmio, cuscinetto, investiti, guadagnoPct, consigliato, allineamento };
}

function setupDi(k) {
    return SETUP[k] || MIO;
}

const fmtPct = x => (x > 0 && x < 1 ? x.toFixed(1).replace('.', ',') : Math.round(x)) + '%';
const fmtMesi = x => `${x.toFixed(1).replace('.', ',').replace(',0', '')} ${x >= 0.95 && x < 1.05 ? 'mese' : 'mesi'}`;

// Where each layer's euro would go under a profile, at today's price. Spending money stays in euro up to the
// profile's months of expenses; the rest is bitcoin, split as the profile says.
function obiettiviPer(st, k) {
    const cfg = SETUP[k] ? cfgDi(k) : st.cfg;
    const { prezzo, strati: s } = st;
    if (st.btcTot > 0 && !prezzo) return null;
    const ora = { fiat: s.fiat.valore };
    for (const x of ORDINE_BTC) ora[x] = prezzo ? s[x].valore * prezzo : 0;
    const tot = Object.values(ora).reduce((a, b) => a + b, 0);
    const cuscinetto = st.spesa ? Math.min(tot, st.spesa * cfg.mesi) : ora.fiat;
    const fiat = cfg.soloFiat ? tot : cuscinetto;
    const b = tot - fiat;
    const ln = cfg.soloFiat ? 0 : Math.min(cfg.ln, LN_MAX, b * LN_QUOTA_MAX);
    const hot = cfg.soloFiat ? 0 : (b * cfg.hot) / 100;
    const meta = { fiat, ln, hot, cold: Math.max(0, b - ln - hot) };
    const ordine = TUTTI_STRATI.filter(x => ora[x] > 0.5 || meta[x] > 0.5);
    return { cfg, ora, meta, ordine, tot, mosse: mosseTra(ora, meta, tot) };
}

function mosseTra(ora, meta, tot) {
    const soglia = Math.max(20, tot * 0.01);
    const d = Object.fromEntries(Object.keys(ora).map(k => [k, meta[k] - ora[k]]));
    const da = Object.keys(d).filter(k => d[k] < -soglia).sort((a, b) => d[a] - d[b]);
    const verso = Object.keys(d).filter(k => d[k] > soglia).sort((a, b) => d[b] - d[a]);
    const out = [];
    for (const a of verso) for (const x of da) {
        const quanto = Math.min(d[a], -d[x]);
        if (quanto < soglia) continue;
        d[a] -= quanto; d[x] += quanto;
        out.push({ da: x, a, euro: quanto });
    }
    return out;
}

// Two pyramids, each drawn from its own amounts, and the same numbers in a table under them.
function confrontoPiramidi(o, titolo) {
    if (!o.ordine.length) return '<p class="nota vuota">Nessun fondo registrato.</p>';
    const [cima, alto, mezza] = [8, 54, 27];
    const disegno = (cx, valori) => pianiPerImporto(valori, cima, alto).map(f =>
        `<polygon points="${trapezio(cx, mezza, cima, alto, f.y1, f.y2)}" fill="${STRATI[f.k].colore}" stroke="var(--superficie)" stroke-width="0.5"/>`).join('');
    const pct = (v, t) => (t > 0 ? fmtPct((v * 100) / t) : '0%');
    const totMeta = Object.values(o.meta).reduce((a, b) => a + b, 0);
    const righe = o.ordine.map(k => {
        const d = o.meta[k] - o.ora[k], piccolo = Math.abs(d) < Math.max(20, o.tot * 0.01);
        return `<span><i style="background:${STRATI[k].colore}"></i>${STRATI[k].icona} ${esc(STRATI[k].nome)}</span>
            <span>${euroTondo(o.ora[k])}<small>${pct(o.ora[k], o.tot)}</small></span>
            <span>${euroTondo(o.meta[k])}<small>${pct(o.meta[k], totMeta)}</small></span>
            <b class="${piccolo ? '' : d > 0 ? 'positivo' : 'negativo'}">${piccolo ? '=' : `${d > 0 ? '+' : '−'}${euroTondo(Math.abs(d))}`}</b>`;
    }).join('');
    return `<svg viewBox="0 0 134 ${cima + alto + 2}" class="confronto">
            <text x="33" y="4.5" class="c-titolo">Oggi</text><text x="67" y="${cima + alto / 2 + 3}" class="c-freccia">→</text><text x="101" y="4.5" class="c-titolo">${esc(titolo)}</text>
            ${disegno(33, o.ora)}${disegno(101, o.meta)}</svg>
        <div class="tabella-confronto"><small></small><small>Oggi</small><small>Tendere</small><small>Δ</small>${righe}</div>`;
}

function elencoMosse(o) {
    if (!o.mosse.length) return '<p class="nota equilibrio">✓ I fondi sono già distribuiti così.</p>';
    return `<ul class="mosse">${o.mosse.map(m => `<li><b>${euroTondo(m.euro)}</b> da ${STRATI[m.da].icona} ${STRATI[m.da].nome} a ${STRATI[m.a].icona} ${STRATI[m.a].nome}</li>`).join('')}</ul>`;
}

// Each floor as big as its share of the wealth, the smallest at the tip. Labels sit beside the pyramid, pushed
// apart when floors are too thin to hold one each, with a line back to their floor.
function piramide(st) {
    const { cfg, prezzo, strati } = st;
    const valori = { fiat: strati.fiat.valore };
    for (const k of ORDINE_BTC) valori[k] = prezzo ? strati[k].valore * prezzo : strati[k].valore;
    // Without a price euro and bitcoin cannot be weighed against each other, so only the bitcoin is drawn.
    if (!prezzo && st.btcTot > 0) valori.fiat = 0;
    const [cima, alto, cx, mezza, passo] = [3, 84, 34, 32, 15];
    const piani = pianiPerImporto(valori, cima, alto);
    if (!piani.length) return '<p class="nota vuota">Nessun fondo registrato: aggiungi un conto o un wallet.</p>';
    const etichette = piani.map(f => (f.y1 + f.y2) / 2);
    for (let i = 1; i < etichette.length; i++) etichette[i] = Math.max(etichette[i], etichette[i - 1] + passo);
    const sfora = etichette[etichette.length - 1] - (cima + alto - 4);
    if (sfora > 0) for (let i = etichette.length - 1; i >= 0; i--) etichette[i] = Math.max(cima + 5 + i * passo, etichette[i] - sfora);
    const obiettivo = k => {
        const s = strati[k];
        if (k === 'fiat') return cfg.soloFiat ? 'tutto in euro' : st.cuscinetto > 0 ? `${cfg.fiatMax ? 'al massimo' : 'cuscinetto'} ${fmtMesi(cfg.mesi)}: ${euroTondo(st.cuscinetto)}` : 'nessuna spesa registrata';
        if (cfg.soloFiat) return 'obiettivo: niente bitcoin';
        if (k === 'ln') return prezzo ? `obiettivo fino a ${euroTondo(s.obiettivoEuro)}` : 'obiettivo: serve il prezzo BTC';
        if (k === 'hot') return `obiettivo ${cfg.hot}% dei bitcoin${prezzo && s.target ? ` · ${euroTondo(s.target * prezzo)}` : ''}`;
        return `obiettivo il resto dei bitcoin · ${fmtPct(s.obiettivo)}`;
    };
    const disegno = piani.map((f, i) => {
        const { k } = f, s = strati[k], d = STRATI[k];
        const troppo = k === 'fiat' ? s.troppo : s.riempito > 1.15 && s.valore - s.target > st.btcTot * 0.02;
        const ym = (f.y1 + f.y2) / 2, ye = etichette[i];
        const valore = k === 'fiat' ? `${euroTondo(s.valore)}${s.mesiCoperti !== null ? ` · ${fmtMesi(s.mesiCoperti)} di spese` : ''}` : `${btc(s.valore)}${prezzo ? ` · ${euroTondo(s.valore * prezzo)}` : ''}`;
        return `<g data-az="strato" data-val="${k}" class="piano">
            <polygon points="${trapezio(cx, mezza, cima, alto, f.y1, f.y2)}" fill="${d.colore}" stroke="${troppo ? 'var(--uscita)' : 'var(--sfondo)'}" stroke-width="${troppo ? 0.8 : 0.5}" ${troppo ? 'stroke-dasharray="2 1.2"' : ''}/>
            <polyline points="${cx + (mezza * (ym - cima)) / alto + 0.8},${ym} 66,${ye} 69,${ye}" fill="none" stroke="var(--bordo)" stroke-width="0.3"/>
            <rect x="69" y="${ye - 7.5}" width="63" height="${passo}" fill="transparent"/>
            <text x="71" y="${ye - 3.4}" class="p-nome">${d.icona} ${esc(d.nome)} <tspan class="${troppo ? 'p-troppo' : 'p-quota'}">${fmtPct(f.quota * 100)}</tspan></text>
            <text x="71" y="${ye + 1.4}" class="p-valore">${esc(valore)}</text>
            <text x="71" y="${ye + 5.8}" class="p-obiettivo">${esc(obiettivo(k))}</text>
        </g>`;
    }).join('');
    const altezza = Math.max(cima + alto, etichette[etichette.length - 1] + 8) + 2;
    return `<svg viewBox="0 0 134 ${altezza}" class="disegno-piramide">${disegno}</svg>`;
}

// Moves between bitcoin layers, each under-filled layer served first by its neighbour: Lightning is topped
// up from the hot wallet, the hot wallet from the cold one, as the Ortix guide does it by hand.
function consigliPiramide(st) {
    const out = [];
    const { strati: s, btcTot, prezzo, cfg } = st;
    const inEuro = b => (prezzo ? ` (≈ ${euroTondo(b * prezzo)})` : '');
    if (cfg.soloFiat) {
        out.push(btcTot > 0
            ? { icona: '🏦', testo: 'Il profilo No coiner tiene tutto in euro, ma qui ci sono dei bitcoin: guarda i profili che li comprendono.', az: 'scegli-setup', val: '' }
            : { icona: '🌱', testo: 'Nessun bitcoin: la piramide è tutta in euro. Il profilo <b>Alle prime armi</b> mostra come si comincerebbe.', az: 'info-setup', val: 'inizio' });
    } else if (btcTot > 0) {
        const soglia = Math.max(btcTot * 0.02, 0.0001);
        const scarto = Object.fromEntries(ORDINE_BTC.map(k => [k, s[k].valore - s[k].target]));
        const vicini = { ln: ['hot', 'cold'], hot: ['cold', 'ln'], cold: ['hot', 'ln'] };
        for (const k of [...ORDINE_BTC].sort((a, b) => scarto[a] - scarto[b])) {
            for (const da of vicini[k]) {
                const quanto = Math.min(-scarto[k], scarto[da]);
                if (quanto < soglia) continue;
                scarto[k] += quanto; scarto[da] -= quanto;
                const perche = da === 'ln' && prezzo && s.ln.valore * prezzo > LN_MAX ? ': oltre 1.000 € i canali diventano scomodi da gestire'
                    : da === 'hot' && s.hot.quota > HOT_MAX ? `: oltre il ${HOT_MAX}% sono troppi fondi esposti` : '';
                out.push({ icona: '⇄', testo: `Sposta <b>${btc(quanto)}</b>${inEuro(quanto)} da ${STRATI[da].icona} ${STRATI[da].nome} a ${STRATI[k].icona} ${STRATI[k].nome}${perche}`, az: 'strato', val: k });
            }
        }
        if (!s.cold.wallet.length) out.unshift({ icona: '❄', testo: 'La base della piramide è vuota: crea un <b>cold wallet</b> (chiavi offline) per il grosso dei bitcoin.', az: 'nuovo-portafoglio', val: 'cold' });
        if (!s.ln.wallet.length && s.ln.target > 0) out.push({ icona: '⚡', testo: 'Nessun wallet <b>Lightning</b>: aggiungine uno per le spese di tutti i giorni.', az: 'nuovo-portafoglio', val: 'ln' });
    } else {
        out.push({ icona: '❄', testo: 'Nessun bitcoin registrato. La piramide parte dalla base: un <b>cold wallet</b>.', az: 'nuovo-portafoglio', val: 'cold' });
    }
    const daDire = s.cold.wallet.filter(w => !w.p.stratoScelto);
    if (daDire.length) out.push({ icona: '?', testo: `${daDire.map(w => `<b>${esc(w.p.nome)}</b>`).join(', ')}: livello non indicato, ${daDire.length > 1 ? 'li conto come cold. Toccali se sono hot' : 'lo conto come cold. Toccalo se è hot'}.`, az: 'strato', val: 'cold' });

    const f = s.fiat.valore, c = st.cuscinetto;
    if (c > 0 && f < c * 0.9) out.push({ icona: '€', testo: `Gli euro coprono <b>${fmtMesi(f / st.spesa)}</b> di spese su ${fmtMesi(cfg.mesi)}: mancano ${euroTondo(c - f)}.`, az: 'strato', val: 'fiat' });
    else if (s.fiat.troppo) {
        out.push(cfg.setup === 'negativo'
            ? { icona: '🧊', testo: `<b>${euroTondo(f - c)}</b> oltre il cuscinetto di ${fmtMesi(cfg.mesi)}: in questo profilo è da qui, e solo da qui, che continua l’accumulo.`, az: 'info-setup', val: 'negativo' }
            : { icona: '₿', testo: `<b>${euroTondo(f - c)}</b> in euro oltre ${cfg.fiatMax ? 'il massimo' : 'il cuscinetto'} di ${fmtMesi(cfg.mesi)}: candidati a diventare bitcoin nel ❄ cold wallet.`, az: 'strato', val: 'fiat' });
    }
    if (cfg.setup === 'inizio' && st.risparmio > 0) out.push({ icona: '🌱', testo: `Risparmi in media <b>${euroTondo(st.risparmio)}</b> al mese: la cifra del PAC verso il ❄ cold wallet si sceglie dentro questa, ogni mese uguale.`, az: 'info-setup', val: 'inizio' });
    if (cfg.setup === 'negativo' && st.spesa > 0) {
        const mese = oggi().slice(0, 7);
        const spese = -tutti('fiat').filter(filtroPersona).filter(m => m.data.startsWith(mese) && m.importo < 0 && !NON_SPESA.test(`${m.tipologia} ${m.categoria}`)).reduce((t, m) => t + m.importo, 0);
        if (spese > st.spesa * 1.1) out.push({ icona: '🧊', testo: `Questo mese hai speso <b>${euroTondo(spese)}</b>, sopra la tua media di ${euroTondo(st.spesa)}.`, az: 'tab', val: 'movimenti' });
    }
    if (cfg.setup === 'positivo' && s.ln.wallet.length) out.push({ icona: '🚀', testo: 'Paga le spese di tutti i giorni dalla punta ⚡ e ricaricala dall’🔥 hot wallet quando si svuota.', az: 'strato', val: 'ln' });
    if (btcTot > 0 && !prezzo) out.push({ icona: '↻', testo: 'Scarica il prezzo BTC: gli obiettivi dipendono dagli importi in euro.', az: 'prezzo', val: '' });
    return out;
}

function schedaSetup(st) {
    const k = st.cfg.setup, s = setupDi(k), c = SETUP[st.consigliato];
    return `<div class="scheda setup" data-tour="setup">
        <div class="setup-riga"><button class="setup-apri" data-az="scegli-setup"><span class="setup-icona">${s.icona}</span>
            <span class="setup-testo"><small>${st.auto ? 'Suggerito dai tuoi fondi' : 'Il tuo profilo'} · cambia ›</small><b>${esc(s.nome)}</b><span>${esc(s.breve)}</span></span></button>
            ${SETUP[k] ? `<button class="info" data-az="info-setup" data-val="${k}" aria-label="Cosa significa">!</button>` : ''}</div>
        ${!st.auto && st.consigliato !== k ? `<button class="setup-somiglia" data-az="info-setup" data-val="${st.consigliato}">I tuoi fondi oggi somigliano a ${c.icona} <b>${esc(c.nome)}</b> ›</button>` : ''}
    </div>`;
}

function tortaPatrimonio(st) {
    const { prezzo, btcTot } = st, eur = st.strati.fiat.valore;
    if (!prezzo) return btcTot ? '<button class="bottone secondario" data-az="prezzo" style="margin-bottom:0.75rem">Scarica il prezzo BTC per il grafico euro/bitcoin</button>' : '';
    const fette = [
        { nome: 'Euro', valore: eur, colore: 'var(--fiat)', testo: euroTondo(eur) },
        { nome: 'Bitcoin', valore: btcTot * prezzo, colore: 'var(--btc)', testo: `${euroTondo(btcTot * prezzo)} · ${btc(btcTot)}` },
    ];
    return torta(fette, ['Bitcoin', fmtPct(eur + btcTot * prezzo > 0 ? (btcTot * prezzo * 100) / (eur + btcTot * prezzo) : 0)]);
}

// Every wallet and account in one list, the emptied ones hidden as they would only clutter it.
function elencoConti(st) {
    const tante = persone().length > 1;
    const righe = Object.values(st.strati).flatMap(s => s.wallet)
        .filter(w => S.mostraZero || Math.abs(w.saldo) >= (w.p.tipo === 'fiat' ? 0.005 : 5e-9))
        .sort((a, b) => (a.p.tipo === b.p.tipo ? 0 : a.p.tipo === 'fiat' ? -1 : 1) || ORDINE_BTC.indexOf(b.p.strato) - ORDINE_BTC.indexOf(a.p.strato) || Math.abs(b.saldo) - Math.abs(a.saldo));
    const nascosti = S.portafogli.size - righe.length;
    return `${righe.map(({ p, saldo }) => `<button class="riga-conto" data-az="apri-conto" data-val="${esc(p.nome)}" data-persona="${esc(p.persona)}">
            <span class="setup-icona" style="color:${STRATI[p.strato].colore}">${STRATI[p.strato].icona}</span>
            <span class="testo"><b>${esc(p.nome)}</b><small>${STRATI[p.strato].nome}${tante ? ` · ${esc(p.persona)}` : ''}</small></span>
            <span class="cifra"><b class="${saldo < 0 ? 'negativo' : ''}">${p.tipo === 'fiat' ? euro(saldo) : btc(saldo)}</b>${p.tipo === 'bitcoin' && st.prezzo ? `<small>≈ ${euroTondo(Math.max(0, saldo) * st.prezzo)}</small>` : ''}</span>
        </button>`).join('') || '<p class="nota vuota">Nessun portafoglio.</p>'}
        <div class="affiancati" style="margin-top:0.6rem">
            <button class="bottone secondario" data-az="nuovo-portafoglio">+ Portafoglio</button>
            ${nascosti > 0 || S.mostraZero ? `<button class="bottone secondario" data-az="mostra-zero">${S.mostraZero ? 'Nascondi quelli a zero' : `Mostra ${nascosti} a zero`}</button>` : ''}
        </div>`;
}

function vistaHome() {
    const st = statoPiramide();
    const { strati: s, btcTot, prezzo } = st;
    const fiat = s.fiat.valore;
    const consigli = consigliPiramide(st);
    const b = btcTot > 0 ? calcoliBitcoin() : null;

    const mese = oggi().slice(0, 7);
    const delMese = tutti('fiat').filter(filtroPersona).filter(m => m.data.startsWith(mese));
    const entrate = delMese.filter(m => m.importo > 0).reduce((t, m) => t + m.importo, 0);
    const uscite = -delMese.filter(m => m.importo < 0).reduce((t, m) => t + m.importo, 0);

    const primiPassi = S.portafogli.size ? '' : `<div class="scheda primi-passi">
        <b>Primi passi</b>
        <p class="nota">Ogni conto o wallet è un portafoglio. Crea quelli che usi davvero: i movimenti si aggiungono poi col +.</p>
        <div class="affiancati"><button class="bottone secondario" data-az="nuovo-portafoglio" data-val="fiat">+ Conto in €</button>
            <button class="bottone btc" data-az="nuovo-portafoglio" data-val="cold">+ Cold wallet ❄</button></div>
    </div>`;

    return `
        <div class="totale-btc" data-tour="totale">
            <small>Patrimonio${S.persona ? ` di ${esc(S.persona)}` : ''}</small>
            <strong class="patrimonio">${prezzo ? euroTondo(fiat + btcTot * prezzo) : btc(btcTot)}</strong>
            <span>${btc(btcTot)} · ${euroTondo(fiat)}</span>
        </div>
        ${chipsPersone(true)}
        ${primiPassi}
        ${schedaSetup(st)}
        <div class="scheda piramide" data-tour="piramide">
            <div class="testa-grafico"><small>Piramide dei fondi</small>
                <span class="allineamento">${st.allineamento !== null ? `<b class="${st.allineamento >= 90 ? 'positivo' : st.allineamento >= 70 ? 'arancio' : 'negativo'}">${Math.round(st.allineamento)}%</b> in equilibrio` : ''}
                <button class="icona piccola" data-az="cfg-piramide" aria-label="Obiettivi della piramide">⚙</button></span></div>
            ${piramide(st)}
            <p class="nota legenda">Ogni piano è grande quanto la sua parte del patrimonio, il più piccolo in punta · bordo rosso = troppi fondi · tocca un piano</p>
            <button class="link-confronto" data-az="info-setup" data-val="${st.cfg.setup}" data-tour="confronto">Oggi → dove tendere ›</button>
        </div>
        <div data-tour="torta">${tortaPatrimonio(st)}</div>
        <div class="sezione" data-tour="consigli"><span>Cosa fare</span></div>
        ${consigli.length ? consigli.map(c => `<button class="consiglio" data-az="${c.az}" data-val="${esc(c.val)}"><b>${c.icona}</b><span>${c.testo}</span></button>`).join('')
            : '<p class="nota equilibrio">✓ La piramide rispetta gli obiettivi del profilo. Niente da spostare.</p>'}
        <p class="nota piccola">${NON_CONSIGLIO}</p>
        ${approfondisci('piramide', 'profili')}
        <div class="sezione" data-tour="conti"><span>Conti e wallet</span><button class="link" data-az="importa">Importa…</button></div>
        <div class="scheda">${elencoConti(st)}</div>
        ${b ? `<div class="sezione"><span>Bitcoin</span><button class="link" data-az="tab" data-val="bitcoin">Movimenti ›</button></div>
        <div class="griglia2">
            <div class="scheda"><small>Investiti</small><strong>${euro(b.netti)}</strong></div>
            <div class="scheda"><small>Guadagno</small><strong class="${b.guadagno === null ? '' : b.guadagno < 0 ? 'negativo' : 'positivo'}">${b.guadagno === null ? '—' : `${euro(b.guadagno, true)}${b.netti > 0 ? ` (${Math.round((b.guadagno / b.netti) * 100)}%)` : ''}`}</strong></div>
            <div class="scheda"><small>Prezzo medio</small><strong>${b.medio ? `€ ${Math.round(b.medio).toLocaleString('it-IT')}` : '—'}</strong></div>
            <button class="scheda" data-az="prezzo" style="text-align:left"><small>Prezzo ↻</small><strong>${b.p ? `€ ${Math.round(b.p).toLocaleString('it-IT')}` : '—'}</strong></button>
        </div>
        <div class="segmenti pieni">
            ${[['mese', 'Mese'], ['trimestre', 'Trimestre'], ['anno', 'Anno']].map(([k, n]) => `<button class="${S.btcPeriodo === k ? 'attivo' : ''}" data-az="btc-periodo" data-val="${k}">${n}</button>`).join('')}
        </div>
        ${grafoBolle(b.acquisti, b.p, b.medio)}` : ''}
        ${acquistaP2P()}
        <div class="sezione"><span>${nomeMese(mese)}</span><button class="link" data-az="tab" data-val="movimenti">Movimenti ›</button></div>
        <div class="riassunto">
            <div class="scheda"><small>Entrate</small><strong class="positivo">${euroTondo(entrate)}</strong></div>
            <div class="scheda"><small>Uscite</small><strong class="negativo">${euroTondo(uscite)}</strong></div>
            <div class="scheda"><small>Spesa media</small><strong>${st.spesa ? euroTondo(st.spesa) : '—'}</strong></div>
        </div>
    `;
}

// ---------- tutorial ----------

// Barattolo's welcome tour: a dark veil, a spotlight on one thing at a time and a bubble that says what it is.
// A step whose target is not on screen is left out, so the tour never gets stuck.
const q = s => document.querySelector(s);
const TAPPE = [
    { trova: () => q('[data-tour=totale]'), testo: '👋 <b>Benvenuto in Bilancio!</b> Qui c’è tutto il patrimonio: euro e bitcoin insieme, al prezzo di oggi.' },
    { trova: () => q('[data-tour=setup]'), testo: 'Il <b>profilo</b> lo suggerisce l’app guardando come sono divisi i tuoi fondi: no coiner, alle prime armi, massimalista… Tocca <b>!</b> per sapere cosa significa.' },
    { trova: () => q('[data-tour=piramide]'), testo: '△ La <b>piramide dei fondi</b>: ❄ cold wallet alla base, 🔥 hot wallet in mezzo, ⚡ Lightning in punta. Ogni piano è grande quanto i suoi fondi, euro compresi: se i conti non tornano, la forma lo mostra. Tocca un piano per i dettagli.' },
    { trova: () => q('[data-tour=confronto]'), testo: 'Due piramidi a confronto: <b>oggi</b> e <b>dove tenderebbero</b> i fondi col profilo. Lo stesso confronto compare quando cambi profilo.' },
    { trova: () => q('[data-tour=torta] .torta'), testo: 'Bitcoin contro euro, al prezzo di oggi.' },
    { trova: () => q('[data-tour=consigli]'), testo: '<b>Cosa fare</b>: gli spostamenti per tenere la piramide in equilibrio. Sono indicazioni, non consigli finanziari.' },
    { trova: () => q('[data-tour=conti]'), testo: 'Scendendo trovi <b>conti e wallet</b>, poi i <b>bitcoin</b> e il mese. Tocca un conto per i suoi movimenti.' },
    { trova: () => q('.nav .fab-centro'), tondo: true, testo: '<b>+</b> aggiunge un movimento: una spesa, un’entrata o un acquisto di bitcoin.' },
    { trova: () => q('.testata [data-az=menu]'), tondo: true, testo: '☰ Dal menu: <b>bollette</b>, sincronizzazione e backup, import da banca e wallet, regole delle categorie e questo tutorial. Buon bilancio! 🎉' },
];
let tour = null;

function avviaTour() {
    chiudiFoglio();
    if (S.tab !== 'home') { S.tab = 'home'; disegna(); }
    window.scrollTo(0, 0);
    const tappe = TAPPE.filter(t => t.trova());
    if (!tappe.length) return;
    tour = { tappe, i: 0 };
    scriviLocale('bilancio.tour', true);
    window.addEventListener('resize', posizionaTour);
    mostraTappa();
}

function mostraTappa() {
    const el = document.getElementById('tour');
    const t = tour.tappe[tour.i], b = t.trova();
    if (!b) { avantiTour(); return; }
    const ultima = tour.i === tour.tappe.length - 1;
    el.hidden = false;
    el.innerHTML = `<div class="tour-luce${t.tondo ? ' tondo' : ''}"></div>
        <div class="tour-fumetto"><span>${t.testo}</span>
            <div class="tour-az"><span class="tour-passo">${tour.i + 1} di ${tour.tappe.length}</span>
                <button class="tour-salta" data-az="tour-salta">Salta</button>
                <button class="tour-avanti" data-az="tour-avanti">${ultima ? 'Fine 🎉' : 'Avanti'}</button></div></div>`;
    const r = b.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 90) b.scrollIntoView({ block: 'center' });
    posizionaTour();
}

function posizionaTour() {
    if (!tour) return;
    const b = tour.tappe[tour.i].trova();
    const luce = q('#tour .tour-luce'), f = q('#tour .tour-fumetto');
    if (!b || !luce || !f) return;
    const r = b.getBoundingClientRect(), R = 6;
    Object.assign(luce.style, { top: `${r.top - R}px`, left: `${r.left - R}px`, width: `${r.width + 2 * R}px`, height: `${Math.min(r.bottom + R, innerHeight - 3) - (r.top - R)}px` });
    const fw = f.offsetWidth, fh = f.offsetHeight;
    let top = r.bottom + R + 12;
    if (top + fh > innerHeight - 12) top = r.top - R - fh - 12;
    if (top < 12) top = Math.max(12, innerHeight - fh - 12);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - fw / 2, innerWidth - fw - 12));
    Object.assign(f.style, { top: `${top}px`, left: `${left}px` });
}

function avantiTour() {
    tour.i++;
    if (tour.i >= tour.tappe.length) chiudiTour();
    else mostraTappa();
}

function chiudiTour() {
    tour = null;
    window.removeEventListener('resize', posizionaTour);
    const el = document.getElementById('tour');
    el.hidden = true;
    el.innerHTML = '';
    window.scrollTo(0, 0);
}

// ---------- where the data lives ----------

// The app has no server, so whether the files survive a lost phone depends on how the folder is synced.
function guidaSync() {
    return `<div class="opzioni-sync">
        <div class="opzione consigliata"><b>🔄 Syncthing</b><small>consigliato</small>
            <p>Copia la cartella tra telefono, PC e Raspberry direttamente, senza passare da un cloud. Gratis e open source.</p></div>
        <div class="opzione"><b>☁ Cloud</b>
            <p>Nextcloud, Google Drive o Dropbox, con un’app che tiene sincronizzata una cartella del telefono (FolderSync, Autosync, Dropsync).</p></div>
        <div class="opzione"><b>📱 Solo sul telefono</b>
            <p>Funziona, ma se perdi o cambi il telefono perdi anche i dati.</p></div>
    </div>
    <p class="nota come-sync">Con Syncthing: installalo sul telefono e sul PC, condividi la cartella <code>Documenti/Casa/Bilancio/dati</code> e sceglila qui. Usa l’app da un dispositivo alla volta.</p>
    ${approfondisci('syncthing', 'backup', 'cloud')}`;
}

// ---------- bills ----------

// A bill is any type that starts with "Bolletta": a new one (Bolletta Internet) shows up by itself.
const BOLLETTA = /^bollett[ae]\b/i;
const COLORI_BOLLETTE = ['#f97316', '#ec4899', '#10b981', '#14b8a6', '#6366f1'];
const COLORE_BOLLETTA = { acqua: '#38bdf8', rifiuti: '#9ca3af', energia: '#facc15', luce: '#facc15', gas: '#a855f7' };

function nomeBolletta(tipologia) {
    return tipologia.replace(BOLLETTA, '').trim() || 'Altre';
}

function chiavePeriodo(data, per) {
    if (per === 'anno') return data.slice(0, 4);
    if (per === 'trimestre') return `${data.slice(0, 4)}-T${Math.floor((Number(data.slice(5, 7)) - 1) / 3) + 1}`;
    return data.slice(0, 7);
}

function etichettaPeriodo(k, per, corta = false) {
    if (per === 'anno') return corta ? `'${k.slice(2)}` : k;
    if (per === 'trimestre') return corta ? `${k.slice(5)} ${k.slice(2, 4)}` : `${k.slice(5)} ${k.slice(0, 4)}`;
    return corta ? MESI[Number(k.slice(5)) - 1].slice(0, 1).toUpperCase() : nomeMese(k);
}

function seguente(k, per) {
    if (per === 'anno') return String(Number(k) + 1);
    if (per === 'trimestre') {
        const [y, t] = [Number(k.slice(0, 4)), Number(k.slice(6))];
        return t === 4 ? `${y + 1}-T1` : `${y}-T${t + 1}`;
    }
    return spostaMese(k, 1);
}

function vistaBollette() {
    const tutte = tutti('fiat').filter(m => BOLLETTA.test(m.tipologia)).filter(filtroPersona);
    const tipi = perUso(tutte.map(m => nomeBolletta(m.tipologia)));
    const colore = Object.fromEntries(tipi.map((t, i) => [t, COLORE_BOLLETTA[t.toLowerCase()] || COLORI_BOLLETTE[i % COLORI_BOLLETTE.length]]));
    if (S.bolTipo && !tipi.includes(S.bolTipo)) S.bolTipo = '';
    const scelte = tutte.filter(m => !S.bolTipo || nomeBolletta(m.tipologia) === S.bolTipo);
    const per = S.bolPeriodo;
    // A refund comes in as a positive amount and lowers that bill.
    const costo = m => -m.importo;

    const somme = new Map();
    for (const m of scelte) {
        const k = chiavePeriodo(m.data, per);
        const g = somme.get(k) || {};
        const t = nomeBolletta(m.tipologia);
        g[t] = (g[t] || 0) + costo(m);
        somme.set(k, g);
    }
    const adesso = chiavePeriodo(oggi(), per);
    const primo = [...somme.keys()].sort()[0] || adesso;
    let elenco = [];
    for (let k = primo; k <= adesso; k = seguente(k, per)) elenco.push(k);
    elenco = elenco.slice(-({ mese: 24, trimestre: 12, anno: 10 }[per]));
    const tot = k => Object.values(somme.get(k) || {}).reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...elenco.map(tot));
    if (!elenco.includes(S.bolScelto)) S.bolScelto = '';
    const scelto = S.bolScelto || [...elenco].reverse().find(k => tot(k) > 0) || adesso;

    const colonne = elenco.map(k => {
        const g = somme.get(k) || {};
        const pezzi = tipi.filter(t => g[t] > 0).map(t => `<i style="height:${(g[t] / max) * 100}%;background:${colore[t]}"></i>`).join('');
        // January carries the year instead of its initial, so a long run of months stays readable.
        const etichetta = per === 'mese' && k.endsWith('-01') ? `<b>${k.slice(2, 4)}</b>` : etichettaPeriodo(k, per, true);
        return `<button class="colonna${k === scelto ? ' scelta' : ''}" data-az="bol-scegli" data-val="${k}">
            <div class="pila">${pezzi}</div><span>${etichetta}</span></button>`;
    }).join('');

    const dettaglio = somme.get(scelto) || {};
    const righeDettaglio = tipi.filter(t => dettaglio[t]).map(t => `<span><i style="background:${colore[t]}"></i>${esc(t)} ${euro(dettaglio[t])}</span>`).join('');

    // The last twelve months against the twelve before, so seasons do not fool the comparison.
    const daMese = d => { const x = new Date(`${oggi().slice(0, 7)}-01T12:00:00`); x.setMonth(x.getMonth() - d); return giorno(x).slice(0, 7); };
    const ultimi = scelte.filter(m => m.data.slice(0, 7) > daMese(12)).reduce((a, m) => a + costo(m), 0);
    const prima = scelte.filter(m => m.data.slice(0, 7) > daMese(24) && m.data.slice(0, 7) <= daMese(12)).reduce((a, m) => a + costo(m), 0);
    const delta = prima > 0 ? Math.round(((ultimi - prima) / prima) * 100) : null;

    const schede = tipi.map(t => {
        const sue = tutte.filter(m => nomeBolletta(m.tipologia) === t);
        const anno12 = sue.filter(m => m.data.slice(0, 7) > daMese(12));
        const ultima = [...sue].sort((a, b) => b.data.localeCompare(a.data))[0];
        const tot12 = anno12.reduce((a, m) => a + costo(m), 0);
        return `<button class="riga-cat conto" data-az="bol-tipo" data-val="${esc(t)}">
            <div class="nome"><span><i class="pallino-bol" style="background:${colore[t]}"></i>${esc(t)}</span><span>${euroTondo(tot12)}</span></div>
            <small>${euroTondo(tot12 / 12)}/mese · ${anno12.length} in 12 mesi${ultima ? ` · ultima ${new Date(`${ultima.data}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' })} ${euroTondo(costo(ultima))}` : ''}</small>
        </button>`;
    }).join('');

    const lista = S.bolTipo ? [...scelte].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 60).map(voce).join('') : '';

    return `
        <div class="segmenti pieni">
            ${[['mese', 'Mese'], ['trimestre', 'Trimestre'], ['anno', 'Anno']].map(([k, n]) => `<button class="${per === k ? 'attivo' : ''}" data-az="bol-periodo" data-val="${k}">${n}</button>`).join('')}
        </div>
        <div class="chips">
            <button class="chip${S.bolTipo ? '' : ' attivo'}" data-az="bol-tipo" data-val="">Tutte</button>
            ${tipi.map(t => `<button class="chip${S.bolTipo === t ? ' attivo' : ''}" data-az="bol-tipo" data-val="${esc(t)}" style="${S.bolTipo === t ? `background:${colore[t]};border-color:${colore[t]};color:#111` : ''}">${esc(t)}</button>`).join('')}
        </div>
        <div class="riassunto">
            <div class="scheda"><small>Ultimi 12 mesi</small><strong>${euroTondo(ultimi)}</strong></div>
            <div class="scheda"><small>Al mese</small><strong>${euroTondo(ultimi / 12)}</strong></div>
            <div class="scheda"><small>Vs anno prima</small><strong class="${delta === null ? '' : delta > 0 ? 'negativo' : 'positivo'}">${delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`}</strong></div>
        </div>
        ${tutte.length ? `<div class="scheda">
            <div class="testa-grafico"><small>${esc(etichettaPeriodo(scelto, per))}</small><strong>${euro(tot(scelto))}</strong></div>
            <div class="colonne">${colonne}</div>
            ${!S.bolTipo && righeDettaglio ? `<div class="legenda">${righeDettaglio}</div>` : ''}
        </div>` : '<p class="vuoto">Nessuna bolletta: sono le uscite con tipologia che inizia per "Bolletta".</p>'}
        ${chipsPersone()}
        ${S.bolTipo ? `<div class="sezione"><span>Pagamenti ${esc(S.bolTipo)}</span></div>${lista}` : `<div class="sezione"><span>Per bolletta</span></div>${schede}`}
    `;
}

function vistaBenvenuto() {
    const permesso = A.permesso();
    const cartella = A.cartella();
    const trovati = cartella && permesso ? tutti('fiat').length + tutti('bitcoin').length : 0;
    const chi = persone();
    return `<div class="benvenuto">
        <h1>Bilancio</h1>
        <p class="nota">Entrate, uscite e bitcoin, con la piramide dei fondi di Ortix. Niente account e niente server: quattro passi e si parte.</p>
        <div class="passo">
            <h3><span class="numero">1</span> Dove tenere i dati</h3>
            <p class="nota">I movimenti sono file CSV in una cartella del telefono, apribili anche con Excel. Perché non si perdano, quella cartella va sincronizzata con un altro dispositivo.</p>
            ${guidaSync()}
        </div>
        <div class="passo">
            <h3>${permesso ? '<span class="fatto">✓</span>' : '<span class="numero">2</span>'} Accesso ai file</h3>
            ${permesso ? '<p class="nota">Concesso.</p>' : `<p class="nota">Serve per leggere e scrivere nella cartella. Nella schermata che si apre, attiva l'interruttore per Bilancio e torna indietro.</p>
            <button class="bottone" data-az="permesso">Consenti accesso ai file</button>`}
        </div>
        <div class="passo${permesso ? '' : ' spento'}">
            <h3>${cartella && permesso ? '<span class="fatto">✓</span>' : '<span class="numero">3</span>'} Cartella dei dati</h3>
            <p class="nota">Scegli la cartella <b>dati</b> (per esempio <b>Documenti/Casa/Bilancio/dati</b>). Se è nuova e vuota va bene: si parte da zero.</p>
            ${cartella ? `<p class="nota"><code>${esc(cartella)}</code><br>${S.vecchioFormato ? 'Qui i dati sono ancora nel formato vecchio (fiat/ e bitcoin/): aspetta che Syncthing porti quello nuovo.' : trovati ? `${trovati} movimenti in ${S.portafogli.size} portafogli.` : 'Nessun movimento qui: si parte da zero.'}</p>` : ''}
            <button class="bottone ${cartella ? 'secondario' : ''}" data-az="cartella" ${permesso ? '' : 'disabled'}>${cartella ? 'Cambia cartella' : 'Scegli cartella'}</button>
        </div>
        ${cartella && permesso ? `<div class="passo">
            <h3><span class="numero">4</span> Chi sei?</h3>
            <p class="nota">Diventa la persona proposta per i nuovi movimenti. In famiglia ognuno ha i suoi portafogli, nella stessa cartella.</p>
            <div class="chips">${chi.map(p => `<button class="chip${pref.io === p ? ' attivo' : ''}" data-az="io" data-val="${esc(p)}">${esc(p)}</button>`).join('')}</div>
            <div class="campo"><input placeholder="Oppure scrivi il nome" data-campo="io" value="${esc(chi.includes(pref.io) ? '' : pref.io)}"></div>
            <button class="bottone" data-az="inizia" ${pref.io ? '' : 'disabled'}>Inizia</button>
        </div>` : ''}
    </div>`;
}

function pronto() {
    return A.permesso() && A.cartella() && pref.io && leggiLocale('bilancio.avviato', false);
}

const TITOLI = { home: 'Bilancio', movimenti: 'Movimenti', bitcoin: 'Bitcoin', bollette: 'Bollette' };

function disegna() {
    const app = document.getElementById('app');
    if (!pronto()) {
        app.innerHTML = vistaBenvenuto();
        return;
    }
    if (!TITOLI[S.tab]) S.tab = 'home';
    const viste = { home: vistaHome, movimenti: vistaMovimenti, bollette: vistaBollette, bitcoin: vistaBitcoin };
    const cerca = document.activeElement?.dataset?.campo === 'cerca';
    const posizione = cerca ? document.activeElement.selectionStart : null;
    app.innerHTML = `
        <header class="testata">${S.tab === 'bitcoin' || S.tab === 'bollette' ? '<button class="icona" data-az="tab" data-val="home" aria-label="Indietro">‹</button>' : '<button class="icona" data-az="menu" aria-label="Menu">☰</button>'}<h1>${TITOLI[S.tab]}</h1></header>
        ${S.conflitti.length ? `<div class="conflitto">⚠ Syncthing ha creato copie in conflitto: i movimenti che contengono non si vedono qui. Uniscile a mano dal PC e cancellale.<br><small>${S.conflitti.map(esc).join(', ')}</small></div>` : ''}
        ${S.vecchioFormato ? '<div class="conflitto">I dati in questa cartella sono ancora nel formato vecchio (fiat/ e bitcoin/). Aspetta che Syncthing porti le cartelle dei portafogli.</div>' : ''}
        <main class="contenuto">${viste[S.tab]()}</main>
        <nav class="nav">
            <button class="${S.tab === 'home' || S.tab === 'bitcoin' ? 'attivo' : ''}" data-az="tab" data-val="home"><b>△</b>Fondi</button>
            <button class="fab-centro" data-az="nuovo" aria-label="Aggiungi un movimento">+</button>
            <button class="${S.tab === 'movimenti' ? 'attivo' : ''}" data-az="tab" data-val="movimenti"><b>☰</b>Movimenti</button>
        </nav>`;
    if (cerca) {
        const el = app.querySelector('[data-campo=cerca]');
        el.focus();
        el.setSelectionRange(posizione, posizione);
    }
}

// ---------- sheets ----------

function apriFoglio(f) {
    S.foglio = f;
    disegnaFoglio();
    // autofocus means nothing in markup set through innerHTML
    if ((f.tipo === 'fiat' || f.tipo === 'bitcoin') && !f.mov) document.querySelector('#foglio [data-campo=importo], #foglio [data-campo=euro]')?.focus();
}

function chiudiFoglio() {
    S.foglio = null;
    document.getElementById('foglio').innerHTML = '';
}

function trova(tipo, id) {
    return tutti(tipo).find(m => m.id === id);
}

function chips(campo, valori, scelto, btcStile = false) {
    return `<div class="chips">${valori.slice(0, 12).map(v =>
        `<button type="button" class="chip${btcStile ? ' btc' : ''}${v === scelto ? ' attivo' : ''}" data-az="metti" data-campo="${campo}" data-val="${esc(v)}">${esc(v)}</button>`).join('')}</div>`;
}

function lista(id, valori) {
    return `<datalist id="${id}">${valori.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
}
const datalist = lista;

// Portfolios of one currency, the most used first.
function nomiPortafogli(tipo, persona) {
    const uso = perUso(tutti(tipo).filter(m => stesso(m.persona, persona)).slice(-300).map(m => m.conto));
    const suoi = portafogliDi(tipo).filter(p => stesso(p.persona, persona)).map(p => p.nome);
    return [...new Set([...uso.filter(n => suoi.includes(n)), ...suoi.sort()])];
}

function disegnaFoglio() {
    const f = S.foglio;
    const el = document.getElementById('foglio');
    if (!f) { el.innerHTML = ''; return; }
    const fogli = { aggiungi: foglioAggiungi, piano: foglioPiano, setup: foglioSetup, infosetup: foglioInfoSetup, sync: foglioSync, piramide: foglioPiramide, livello: foglioLivello, menu: foglioMenu, regole: foglioRegole, impostazioni: foglioImpostazioni, bitcoin: foglioBitcoin, fiat: foglioFiat, portafoglio: foglioPortafoglio, importa: foglioImporta };
    const forma = f.tipo === 'menu' ? 'pannello cassetto' : f.tipo === 'regole' ? 'pannello pieno' : 'pannello';
    el.innerHTML = `<div class="velo" data-az="chiudi"></div><div class="${forma}">${f.tipo === 'menu' ? '' : '<div class="maniglia"></div>'}${fogli[f.tipo](f)}</div>`;
}

function foglioFiat(f) {
    const m = f.mov;
    const fiat = tutti('fiat');
    const io = pref.io;
    const v = f.bozza || {
        uscita: m ? m.importo < 0 : false,
        importo: m ? String(m.importo).replace('.', ',') : '',
        data: m ? m.data : oggi(),
        descrizione: m?.descrizione || '',
        tipologia: m?.tipologia || '',
        categoria: m?.categoria || '',
        conto: m ? m.conto : (S.conto && trovaPortafoglio(io, S.conto)?.tipo === 'fiat' ? S.conto : nomiPortafogli('fiat', io)[0] || ''),
        persona: m ? m.persona : io,
    };
    f.bozza = v;
    const tipologie = perUso(fiat.filter(x => (x.importo < 0) === v.uscita).map(x => x.tipologia));
    const conti = nomiPortafogli('fiat', v.persona);
    return `
        <h2>${m ? 'Modifica movimento' : 'Nuovo movimento'}<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <div class="interruttore">
            <button type="button" class="u${v.uscita ? ' attivo' : ''}" data-az="verso" data-val="u">Spesa</button>
            <button type="button" class="e${v.uscita ? '' : ' attivo'}" data-az="verso" data-val="e">Entrata</button>
        </div>
        <div class="campo importo"><input data-campo="importo" inputmode="text" placeholder="−12,50 spesa · 12,50 entrata" value="${esc(v.importo)}" autocomplete="off"></div>
        <div class="campo"><label>Descrizione</label>
            <input data-campo="descrizione" list="l-descr" value="${esc(v.descrizione)}" placeholder="Es. Spesa Lidl" autocomplete="off">
            ${lista('l-descr', perUso(fiat.slice(-1500).map(x => x.descrizione)).slice(0, 300))}
        </div>
        <div class="campo"><label>Tipologia</label>
            <input data-campo="tipologia" list="l-tip" value="${esc(v.tipologia)}" autocomplete="off">
            ${lista('l-tip', tipologie)}${chips('tipologia', tipologie, v.tipologia)}
            ${v.descrizione.trim() ? `<button type="button" class="collegamento" data-az="regole">＋ Regola: «${esc(v.descrizione.trim().toLowerCase())}» va sempre in questa tipologia</button>` : ''}
        </div>
        <div class="affiancati">
            <div class="campo"><label>Categoria</label>
                <input data-campo="categoria" list="l-cat" value="${esc(v.categoria)}" autocomplete="off">${lista('l-cat', perUso(fiat.map(x => x.categoria)))}
            </div>
            <div class="campo"><label>Data</label><input type="date" data-campo="data" value="${esc(v.data)}"></div>
        </div>
        <div class="campo"><label>Portafoglio</label>
            <input data-campo="conto" list="l-conto" value="${esc(v.conto)}" autocomplete="off">${lista('l-conto', conti)}${chips('conto', conti, v.conto)}
        </div>
        <div class="campo"><label>Persona</label>
            <input data-campo="persona" list="l-pers" value="${esc(v.persona)}" autocomplete="off">${lista('l-pers', persone())}${chips('persona', persone(), v.persona)}
        </div>
        ${f.errore ? `<p class="errore">${esc(f.errore)}</p>` : ''}
        <button class="bottone" data-az="salva">${m ? 'Salva modifiche' : 'Salva'}</button>
        ${m ? '<button class="bottone pericolo" data-az="elimina" style="margin-top:0.6rem">Elimina movimento</button>' : ''}
    `;
}

// Sats are whole numbers, so dots and spaces in "21.000" are only thousands separators.
function satsDa(testo) {
    const t = String(testo || '').trim();
    const n = Number(t.replace(/[^\d]/g, '') || 0);
    return /^[-−]/.test(t) ? -n : n;
}

function testoControvalore(v) {
    const q = satsDa(v.quanti) / 1e8;
    const scritti = numero(v.euro);
    const p = prezzoNoto(v.data);
    if (scritti > 0 && q) return `Prezzo: € ${Math.round(scritti / Math.abs(q)).toLocaleString('it-IT')} per BTC`;
    if (!p) return 'Prezzo non disponibile: scrivi gli euro a mano, o salva solo i sats.';
    const quando = v.data === oggi() || !storico[v.data] ? 'di oggi' : `del ${new Date(`${v.data}T12:00:00`).toLocaleDateString('it-IT')}`;
    return q ? `≈ ${euro(Math.abs(q) * p)} al prezzo ${quando} (€ ${Math.round(p).toLocaleString('it-IT')}/BTC)` : `Prezzo ${quando}: € ${Math.round(p).toLocaleString('it-IT')}/BTC`;
}

function aggiornaControvalore() {
    const el = document.querySelector('[data-prezzo]');
    if (el && S.foglio?.bozza) el.textContent = testoControvalore(S.foglio.bozza);
}

function foglioBitcoin(f) {
    const m = f.mov;
    const v = f.bozza || {
        uscita: m ? m.bitcoin < 0 : false,
        euro: m ? String(Math.abs(m.euro)).replace('.', ',') : '',
        quanti: m ? String(Math.round(m.bitcoin * 1e8)) : '',
        data: m ? m.data : oggi(),
        persona: m ? m.persona : pref.io,
        conto: m ? m.conto : (S.conto && trovaPortafoglio(pref.io, S.conto)?.tipo === 'bitcoin' ? S.conto : nomiPortafogli('bitcoin', pref.io)[0] || 'Bitcoin'),
        descrizione: m?.descrizione || '',
    };
    f.bozza = v;
    if (!(v.data in storico)) prezzoDel(v.data).then(() => S.foglio?.tipo === 'bitcoin' && aggiornaControvalore());
    const conti = nomiPortafogli('bitcoin', v.persona);
    return `
        <h2>${m ? 'Modifica' : 'Nuovo'} movimento bitcoin<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <div class="interruttore">
            <button type="button" class="e${v.uscita ? '' : ' attivo'}" data-az="verso" data-val="e">${trovaPortafoglio(v.persona, v.conto)?.rete === 'LN' ? 'Ricevuti' : 'Acquisto'}</button>
            <button type="button" class="u${v.uscita ? ' attivo' : ''}" data-az="verso" data-val="u">${trovaPortafoglio(v.persona, v.conto)?.rete === 'LN' ? 'Spesi' : 'Vendita'}</button>
        </div>
        <div class="campo importo"><input data-campo="quanti" inputmode="text" placeholder="−21000 spesi · 21000 entrati" value="${esc(v.quanti)}" autocomplete="off"><span class="unita">sat</span></div>
        <div class="campo"><label>Euro <span class="facoltativo">calcolati da soli, cambiali solo se li sai</span></label><input data-campo="euro" inputmode="decimal" placeholder="—" value="${esc(v.euro)}" autocomplete="off"></div>
        <p class="nota" data-prezzo>${testoControvalore(v)}</p>
        <div class="affiancati">
            <div class="campo"><label>Data</label><input type="date" data-campo="data" value="${esc(v.data)}"></div>
            <div class="campo"><label>Persona</label><input data-campo="persona" list="l-pers" value="${esc(v.persona)}" autocomplete="off">${lista('l-pers', persone())}</div>
        </div>
        ${conti.length !== 1 || conti[0] !== v.conto ? `<div class="campo"><label>Portafoglio</label><input data-campo="conto" list="l-conto" value="${esc(v.conto)}" autocomplete="off">${lista('l-conto', conti)}${chips('conto', conti, v.conto, true)}</div>` : ''}
        <div class="campo"><label>Descrizione</label><input data-campo="descrizione" value="${esc(v.descrizione)}" placeholder="Es. DCA mensile" autocomplete="off"></div>
        ${f.errore ? `<p class="errore">${esc(f.errore)}</p>` : ''}
        <button class="bottone btc" data-az="salva">${m ? 'Salva modifiche' : 'Salva'}</button>
        ${m ? '<button class="bottone pericolo" data-az="elimina" style="margin-top:0.6rem">Elimina movimento</button>' : ''}
    `;
}

function foglioPortafoglio(f) {
    const v = f.bozza || (f.bozza = { nome: '', valuta: 'EUR', strato: 'cold', persona: S.persona || pref.io });
    return `
        <h2>Nuovo portafoglio<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <div class="interruttore">
            <button type="button" class="e${v.valuta === 'EUR' ? ' attivo' : ''}" data-az="valuta" data-val="EUR">€ Euro</button>
            <button type="button" class="u${v.valuta === 'BTC' ? ' attivo' : ''}" data-az="valuta" data-val="BTC">₿ Bitcoin</button>
        </div>
        ${v.valuta === 'BTC' ? `<div class="campo"><label>Livello della piramide</label><div class="chips">
            ${ORDINE_BTC.slice().reverse().map(k => `<button type="button" class="chip btc${v.strato === k ? ' attivo' : ''}" data-az="strato-nuovo" data-val="${k}">${STRATI[k].icona} ${STRATI[k].nome}</button>`).join('')}
        </div><p class="nota">${esc(STRATI[v.strato]?.ruolo || '')}: ${esc(STRATI[v.strato]?.uso || '')}</p></div>` : ''}
        <div class="campo"><label>Nome</label><input data-campo="nome" value="${esc(v.nome)}" placeholder="${v.valuta === 'BTC' ? 'Es. Phoenix' : 'Es. Conto Revolut'}" autocomplete="off"></div>
        <div class="campo"><label>Di chi</label>
            <input data-campo="persona" list="l-pers" value="${esc(v.persona)}" autocomplete="off">${lista('l-pers', persone())}${chips('persona', persone(), v.persona)}
        </div>
        <p class="nota">Diventa la cartella <code>dati/${esc(v.persona.trim() || 'Persona')}/${esc(v.nome.trim() || 'Nome')}</code>, con dentro un file per anno.</p>
        ${f.errore ? `<p class="errore">${esc(f.errore)}</p>` : ''}
        <button class="bottone${v.valuta === 'BTC' ? ' btc' : ''}" data-az="crea-portafoglio">Crea portafoglio</button>
    `;
}

function foglioPiramide(f) {
    const b = f.bozza;
    return `
        <h2>Personalizza la piramide<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">Gli obiettivi sono importi: il cold wallet prende tutto quello che resta.</p>
        <div class="griglia2">
            <div class="campo"><label>🔥 Hot wallet</label><div class="con-unita"><input data-campo="hot" inputmode="decimal" value="${esc(b.hot)}"><span>%</span></div>
                <small class="aiuto">al massimo ${HOT_MAX}%: sono fondi esposti</small></div>
            <div class="campo"><label>⚡ Lightning</label><div class="con-unita"><span>€</span><input data-campo="ln" inputmode="numeric" value="${esc(b.ln)}"></div>
                <small class="aiuto">al massimo ${euroTondo(LN_MAX)}: i canali</small></div>
        </div>
        <div class="campo"><label>Mesi di spese in euro</label>
            <div class="chips">${[1, 2, 3, 6, 12].map(m => `<button type="button" class="chip${Number(b.mesi) === m ? ' attivo' : ''}" data-az="mesi-cuscinetto" data-val="${m}">${m}</button>`).join('')}</div>
            <div class="chips">
                <button type="button" class="chip${!b.fiatMax ? ' attivo' : ''}" data-az="fiat-max" data-val="">Almeno, come cuscinetto</button>
                <button type="button" class="chip${b.fiatMax ? ' attivo' : ''}" data-az="fiat-max" data-val="1">Al massimo</button></div>
            <p class="nota">Spesa media degli ultimi 12 mesi: ${euroTondo(medieMensili().spesa)} (senza acquisti di bitcoin e giroconti).</p></div>
        ${f.errore ? `<p class="errore">${esc(f.errore)}</p>` : ''}
        <button class="bottone btc" data-az="salva-piramide">Salva</button>
    `;
}

function foglioAggiungi() {
    return `
        <h2>Aggiungi<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <button class="voce-menu" data-az="nuovo-tipo" data-val="fiat"><b>€</b><span>Entrata o uscita<small>Spesa, stipendio, bolletta…</small></span></button>
        <button class="voce-menu" data-az="nuovo-tipo" data-val="bitcoin"><b class="arancio">₿</b><span>Bitcoin<small>Acquisto, vendita, sats ricevuti o spesi</small></span></button>
        <button class="voce-menu" data-az="nuovo-portafoglio"><b>▣</b><span>Portafoglio<small>Un conto in euro o un wallet</small></span></button>
    `;
}

function foglioPiano() {
    const st = statoPiramide(), k = S.strato, d = STRATI[k], dati = st.strati[k];
    const wallet = dati.wallet.map(({ p, saldo }) => `<button class="riga-cat conto" data-az="${p.tipo === 'bitcoin' ? 'livello-wallet' : 'apri-conto'}" data-val="${esc(p.nome)}" data-persona="${esc(p.persona)}">
            <div class="nome"><span>${esc(p.nome)}${persone().length > 1 ? ` <small style="color:var(--tenue)">${esc(p.persona)}</small>` : ''}${p.tipo === 'bitcoin' && !p.stratoScelto ? ' <small class="arancio">livello?</small>' : ''}</span>
            <span class="${saldo < 0 ? 'negativo' : ''}">${p.tipo === 'fiat' ? euro(saldo) : btc(saldo)}</span></div>
            <small>${p.tipo === 'bitcoin' ? `${st.prezzo ? `≈ ${euroTondo(Math.max(0, saldo) * st.prezzo)} · ` : ''}tocca per cambiare livello` : 'tocca per i movimenti'}</small>
        </button>`).join('');
    return `
        <div class="livello" style="--c:${d.colore}">
            <h2>${d.icona} ${d.nome}<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
            <p class="nota">${esc(d.ruolo)}</p>
            <dl>
                <dt>Uso</dt><dd>${esc(d.uso)}</dd>
                <dt>Sicurezza</dt><dd>${esc(d.sicurezza)}</dd>
                <dt>Esempi</dt><dd>${esc(d.esempi)}</dd>
                <dt>Concetto</dt><dd>${esc(d.concetto)}</dd>
            </dl>
            ${wallet || '<p class="nota vuota">Nessun portafoglio in questo livello.</p>'}
            <button class="bottone secondario" data-az="nuovo-portafoglio" data-val="${k}">+ ${k === 'fiat' ? 'Conto in €' : `Portafoglio ${d.icona}`}</button>
            ${approfondisci(...d.articoli)}
        </div>
    `;
}

function foglioSetup() {
    const st = statoPiramide(), c = SETUP[st.consigliato];
    return `
        <h2>Scegli un profilo<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">Esempi di come organizzare la piramide in situazioni diverse. Toccane uno per vedere come si sposterebbero i tuoi fondi.</p>
        <div class="riga-setup${st.auto ? ' attivo' : ''}">
            <button class="setup-apri" data-az="usa-setup" data-val="auto"><span class="setup-icona">✨</span>
                <span class="setup-testo"><b>Automatico${st.auto ? ' <em class="in-uso">in uso</em>' : ''}</b><span>Segue i tuoi fondi: oggi ${c.icona} ${esc(c.nome)}.</span></span></button>
        </div>
        ${Object.entries(SETUP).map(([k, x]) => `<div class="riga-setup${!st.auto && st.cfg.setup === k ? ' attivo' : ''}">
            <button class="setup-apri" data-az="info-setup" data-val="${k}"><span class="setup-icona">${x.icona}</span>
                <span class="setup-testo"><b>${esc(x.nome)}${st.consigliato === k ? ' <em>somiglia ai tuoi fondi</em>' : ''}${!st.auto && st.cfg.setup === k ? ' <em class="in-uso">in uso</em>' : ''}</b><span>${esc(x.breve)}</span></span></button>
            <button class="info" data-az="info-setup" data-val="${k}" aria-label="Cosa significa ${esc(x.nome)}">!</button>
        </div>`).join('')}
        <button class="bottone secondario" data-az="cfg-piramide">✎ Personalizza a mano</button>
        <p class="nota avviso-finanza">! ${NON_CONSIGLIO}</p>
    `;
}

function foglioInfoSetup(f) {
    const k = f.setup, st = statoPiramide(), x = SETUP[k] || MIO;
    const o = obiettiviPer(st, k);
    const inUso = !st.auto && st.cfg.setup === k;
    return `
        <h2>${x.icona} ${esc(x.nome)}<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">${esc(x.breve)}</p>
        <div class="scheda confronto-scheda">
            ${o ? `${confrontoPiramidi(o, x.nome)}${elencoMosse(o)}` : '<p class="nota">Serve il prezzo BTC per confrontare le piramidi.</p>'}
            <p class="nota piccola">Dove tenderebbero i tuoi fondi con questo profilo, al prezzo di oggi.${k === 'inizio' ? ' Gli euro oltre il cuscinetto li sposta il PAC, un mese alla volta.' : ''}</p>
        </div>
        ${inUso ? '<p class="nota equilibrio">✓ È il profilo in uso.</p>' : SETUP[k] ? `<button class="bottone btc" data-az="usa-setup" data-val="${k}">Usa questo profilo</button>` : ''}
        ${SETUP[k] ? `<div class="campo"><label>Per chi</label><p>${esc(x.per)}</p></div>
        <div class="campo"><label>Come funziona</label><ul class="regole-setup">${x.regole.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
        <div class="numeri-setup">
            <div><small>🔥 Hot</small><b>${x.hot}%</b></div>
            <div><small>⚡ Lightning</small><b>${x.ln ? `fino a ${euroTondo(x.ln)}` : '—'}</b></div>
            <div><small>€ Euro</small><b>${x.soloFiat ? 'tutto' : `${x.fiatMax ? 'max ' : ''}${fmtMesi(x.mesi)}`}</b></div>
        </div>` : ''}
        ${approfondisci(...(x.articoli || []), 'profili')}
        <div class="avviso-finanza"><b>!</b><span>${NON_CONSIGLIO} Nessuno ti dice cosa comprare o vendere: l’app mostra solo come starebbero i tuoi fondi con questo schema.</span></div>
        <button class="bottone secondario" data-az="scegli-setup">Tutti i profili</button>
    `;
}

function foglioSync() {
    return `
        <h2>Sincronizzazione e backup<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">Bilancio non ha un server: i movimenti sono file CSV nella cartella <code>${esc(A.cartella() || '—')}</code>. Che non si perdano dipende da come la sincronizzi.</p>
        ${guidaSync()}
        <button class="bottone secondario" data-az="cartella">Cambia cartella</button>
    `;
}

function foglioLivello(f) {
    const p = trovaPortafoglio(f.persona, f.nome);
    if (!p) return '<p class="nota">Portafoglio non trovato.</p>';
    return `
        <h2>${esc(p.nome)}<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">In quale livello della piramide sta? ${p.stratoScelto ? '' : 'Non è ancora stato indicato: per ora è contato come cold.'}</p>
        ${ORDINE_BTC.slice().reverse().map(k => `<button class="voce-menu livello-scelta${p.strato === k && p.stratoScelto ? ' attivo' : ''}" data-az="metti-strato" data-val="${k}">
            <b>${STRATI[k].icona}</b><span>${STRATI[k].nome}<small>${esc(STRATI[k].uso)} · es. ${esc(STRATI[k].esempi)}</small></span></button>`).join('')}
        <p class="nota">Scrive il livello in <code>${esc(p.cartella)}/portafoglio.json</code>. Lightning vuol dire che i sats ricevuti lì sono pagamenti, non acquisti.</p>
        <button class="bottone secondario" data-az="vedi-movimenti">Vedi i movimenti</button>
    `;
}

function foglioMenu() {
    const sospese = tutti('fiat').filter(daClassificare).length;
    return `
        <h2>Bilancio</h2>
        <button class="voce-menu" data-az="vai" data-val="bollette"><b>⚡</b><span>Bollette<small>Luce, gas, acqua, rifiuti</small></span></button>
        <button class="voce-menu" data-az="vai" data-val="bitcoin"><b>₿</b><span>Bitcoin<small>Acquisti, prezzo medio, sats</small></span></button>
        <button class="voce-menu" data-az="regole"><b>⇄</b><span>Regole delle categorie<small>${regole().length} regole${sospese ? ` · ${sospese} da classificare` : ''}</small></span></button>
        <button class="voce-menu" data-az="importa"><b>⇩</b><span>Importa movimenti<small>BBVA, Phoenix, BlueWallet…</small></span></button>
        <button class="voce-menu" data-az="scegli-setup"><b>△</b><span>Profilo della piramide<small>${esc(setupDi(statoPiramide().cfg.setup).nome)}${configPiramide() ? '' : ' (automatico)'}</small></span></button>
        <button class="voce-menu" data-az="sync"><b>🔄</b><span>Sincronizzazione e backup<small>Syncthing o cloud: dove stanno i dati</small></span></button>
        <a class="voce-menu" href="${ORTIX}" target="_blank" rel="noopener"><b>📖</b><span>Articoli di Ortix<small>Piramide, wallet, Lightning, Syncthing</small></span></a>
        <button class="voce-menu" data-az="tutorial"><b>?</b><span>Tutorial<small>Il giro guidato dell’app</small></span></button>
        <button class="voce-menu" data-az="impostazioni"><b>⚙</b><span>Impostazioni</span></button>
        <button class="voce-menu" data-az="ricarica"><b>↻</b><span>Rileggi i file</span></button>
    `;
}

function foglioImpostazioni() {
    return `
        <h2>Impostazioni<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <div class="campo"><label>Chi sei</label>${chips('io', persone(), pref.io)}</div>
        <div class="campo"><label>Unità bitcoin</label>
            <div class="chips">
                <button class="chip btc${pref.unita === 'BTC' ? ' attivo' : ''}" data-az="unita" data-val="BTC">₿ BTC</button>
                <button class="chip btc${pref.unita === 'SAT' ? ' attivo' : ''}" data-az="unita" data-val="SAT">⚡ sat</button>
            </div>
        </div>
        <div class="campo"><label>Cartella dei dati</label><p class="nota"><code>${esc(A.cartella())}</code></p>
            <button class="bottone secondario" data-az="cartella">Cambia cartella</button>
        </div>
        <button class="bottone secondario" data-az="ricarica">Rileggi i file</button>
        <p class="nota" style="margin-top:1rem">${tutti('fiat').length} movimenti in euro e ${tutti('bitcoin').length} in bitcoin, in ${S.portafogli.size} portafogli.</p>
    `;
}

// ---------- category rules ----------

// Kept next to the data, in dati/regole.json, so every phone and the web app file the same shop the same way.
const REGOLE = 'regole.json';

function regole() {
    try { return JSON.parse(A.leggi(REGOLE) || '{}').regole || []; } catch { return []; }
}

function salvaRegole(lista) {
    const errore = A.scrivi(REGOLE, JSON.stringify({ regole: lista }, null, 2) + '\n');
    if (errore) throw new Error(errore);
}

function daClassificare(m) {
    return !m.tipologia || stesso(m.tipologia, 'Da classificare');
}

// The first rule whose text is in the description wins, so a narrower rule goes above a broader one.
function regolaPer(descrizione, lista = regole()) {
    const d = String(descrizione || '').toLowerCase();
    return d ? lista.find(x => x.testo && d.includes(x.testo.toLowerCase())) : undefined;
}

// A rule without a category files the movement where that type usually goes.
function categoriaPer(x) {
    return x.categoria || perUso(tutti('fiat').filter(m => m.tipologia === x.tipologia && !stesso(m.categoria, 'Da classificare')).map(m => m.categoria))[0] || '';
}

function applicaRegole() {
    const lista = regole();
    const daCambiare = tutti('fiat').filter(m => daClassificare(m) && regolaPer(m.descrizione, lista));
    const gruppi = new Map();
    for (const m of daCambiare) {
        const k = `${m.persona}/${m.conto}/${m.data.slice(0, 4)}`;
        (gruppi.get(k) || gruppi.set(k, []).get(k)).push(m.id);
    }
    for (const [k, ids] of gruppi) {
        const [persona, conto, anno] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1, k.lastIndexOf('/')), k.slice(k.lastIndexOf('/') + 1)];
        const quali = new Set(ids);
        cambiaAnno(trovaPortafoglio(persona, conto), anno, righe => righe.map(m => {
            if (!quali.has(m.id)) return m;
            const x = regolaPer(m.descrizione, lista);
            return { ...m, tipologia: x.tipologia, categoria: categoriaPer(x) };
        }));
    }
    return daCambiare.length;
}

function foglioRegole(f) {
    const v = f.bozza || (f.bozza = { testo: '', tipologia: '', categoria: '' });
    const lista = regole();
    const fiat = tutti('fiat');
    const tipologie = perUso(fiat.filter(m => !daClassificare(m)).map(m => m.tipologia));
    const categorie = perUso(fiat.map(m => m.categoria).filter(c => c && !stesso(c, 'Da classificare')));
    const sospese = fiat.filter(daClassificare);
    const coperte = sospese.filter(m => regolaPer(m.descrizione, lista)).length;
    const perDescr = new Map();
    for (const m of sospese) {
        const d = m.descrizione || '(senza descrizione)';
        const g = perDescr.get(d) || { d, n: 0, regola: regolaPer(m.descrizione, lista) };
        g.n++; perDescr.set(d, g);
    }
    const elenco = [...perDescr.values()].filter(g => !g.regola).sort((a, b) => b.n - a.n).slice(0, 40);
    const prova = v.testo.trim() ? sospese.filter(m => m.descrizione.toLowerCase().includes(v.testo.trim().toLowerCase())).length : 0;
    return `
        <h2>Regole delle categorie<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">Se la descrizione di un movimento contiene il testo, gli do tipologia e categoria. Valgono per i movimenti da classificare, per gli import e quando scrivi una descrizione nuova.</p>
        <div class="campo"><label>Se la descrizione contiene</label><input data-campo="testo" value="${esc(v.testo)}" placeholder="Es. esselunga" autocomplete="off"></div>
        ${v.testo.trim() ? `<p class="nota" data-prova>${prova} movimenti da classificare la contengono</p>` : '<p class="nota" data-prova>&nbsp;</p>'}
        <div class="affiancati">
            <div class="campo"><label>Tipologia</label><input data-campo="tipologia" list="l-tip" value="${esc(v.tipologia)}" autocomplete="off">${datalist('l-tip', tipologie)}</div>
            <div class="campo"><label>Categoria</label><input data-campo="categoria" list="l-cat" value="${esc(v.categoria)}" autocomplete="off">${datalist('l-cat', categorie)}</div>
        </div>
        ${chips('tipologia', tipologie, v.tipologia)}
        ${f.errore ? `<p class="errore">${esc(f.errore)}</p>` : ''}
        <button class="bottone" data-az="aggiungi-regola">Aggiungi regola</button>
        ${lista.length ? `<div class="sezione"><span>Regole (${lista.length})</span></div>
            ${lista.map((x, i) => `<div class="regola"><span>«${esc(x.testo)}» → <b>${esc(x.tipologia)}</b>${x.categoria ? ` · ${esc(x.categoria)}` : ''}</span>
                <span>${i ? `<button class="icona" data-az="sposta-regola" data-val="${i}" aria-label="Più in alto">↑</button>` : ''}<button class="icona" data-az="togli-regola" data-val="${i}" aria-label="Togli">✕</button></span></div>`).join('')}` : ''}
        ${sospese.length ? `<div class="sezione"><span>Da classificare (${sospese.length})</span></div>
            ${coperte ? `<button class="bottone" data-az="applica-regole">Applica le regole a ${coperte} movimenti</button>` : ''}
            <p class="nota">Tocca una descrizione per farne una regola.</p>
            <div class="chips a-capo">${elenco.map(g => `<button class="chip" data-az="da-descrizione" data-val="${esc(g.d)}">${esc(g.d)}${g.n > 1 ? ` <small>×${g.n}</small>` : ''}</button>`).join('')}</div>` : ''}
    `;
}

// ---------- import (draft: the column guesses are not yet checked against a real export) ----------

const FONTI = {
    bbva: { nome: 'BBVA', valuta: 'EUR', conto: 'BBVA', nota: 'Export dei movimenti dall\'app o dal sito BBVA, in CSV (un .xlsx va prima salvato come CSV).' },
    phoenix: { nome: 'Phoenix', valuta: 'BTC', rete: 'LN', conto: 'Phoenix', nota: 'Impostazioni → Pagamenti → Esporta in CSV.' },
    blixt: { nome: 'Blixt', valuta: 'BTC', rete: 'LN', conto: 'Blixt', nota: 'Export delle transazioni di Blixt Wallet in CSV.' },
    csv: { nome: 'Altro CSV', valuta: null, conto: '', nota: 'Qualsiasi CSV con una colonna di data e una di importo.' },
};

function trovaColonna(testa, ...prove) {
    for (const re of prove) {
        const i = testa.findIndex(h => re.test(h.trim()));
        if (i >= 0) return i;
    }
    return -1;
}

function dataDa(s) {
    const t = String(s ?? '').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (/^\d{9,13}$/.test(t)) return giorno(new Date(Number(t) * (t.length > 11 ? 1 : 1000)));
    return null;
}

// Finds the header row and the columns by name, so one reader covers the bank and the wallets.
function analizzaImport(testo, valuta) {
    const pulito = (testo || '').replace(/^﻿/, '');
    const prima = pulito.split(/\r?\n/).find(l => l.trim()) || '';
    const sep = [';', '\t', ','].sort((a, b) => prima.split(b).length - prima.split(a).length)[0];
    const righe = righeCSV(pulito, sep);
    const iTesta = righe.findIndex(r => r.some(h => /^(data|date|fecha|timestamp|time|created)/i.test(h.trim())));
    if (iTesta < 0) throw new Error('Non trovo una colonna con la data (Data, Date, Fecha, timestamp…)');
    const testa = righe[iTesta];
    const corpo = righe.slice(iTesta + 1).filter(r => r.some(c => c.trim()));
    const col = {
        data: trovaColonna(testa, /^data (operazione|contabile)/i, /^(date|fecha|data)$/i, /^(timestamp|created|time)/i, /data|date|fecha/i),
        descr: trovaColonna(testa, /descri|concepto|causale|memo|description|note|label|message/i),
        verso: trovaColonna(testa, /^(type|tipo|direction|verso)$/i),
        fiat: trovaColonna(testa, /amount_?fiat|fiat|eur(o)?$/i),
    };
    const msat = trovaColonna(testa, /msat/i);
    const sat = trovaColonna(testa, /(^|_|\s)sats?($|_|\s)|satoshi|amount_?sat/i);
    const btcCol = trovaColonna(testa, /btc|bitcoin/i);
    const importo = trovaColonna(testa, /^importo|^importe|^amount$|^ammontare|^valore/i, /importo|importe|amount/i);
    const entrate = trovaColonna(testa, /entrat|avere|accredit|credit/i);
    const usciteC = trovaColonna(testa, /uscit|dare|addebit|debit/i);
    let quanto;
    if (valuta === 'BTC') {
        if (msat >= 0) quanto = r => numero(r[msat]) / 1e11;
        else if (sat >= 0) quanto = r => numero(r[sat]) / 1e8;
        else if (btcCol >= 0) quanto = r => numero(r[btcCol]);
        else if (importo >= 0) quanto = r => numero(r[importo]) / 1e8;
    } else if (importo >= 0) quanto = r => numero(r[importo]);
    else if (entrate >= 0 && usciteC >= 0) quanto = r => (numero(r[entrate]) || 0) - Math.abs(numero(r[usciteC]) || 0);
    if (!quanto) throw new Error(`Non trovo la colonna dell'importo${valuta === 'BTC' ? ' in sat o msat' : ''}`);

    const lette = corpo.map(r => ({ data: dataDa(r[col.data]), q: quanto(r), descr: col.descr >= 0 ? r[col.descr].trim() : '', verso: col.verso >= 0 ? r[col.verso] : '', fiat: col.fiat >= 0 ? numero(r[col.fiat]) : NaN }));
    const buone = lette.filter(x => x.data && Number.isFinite(x.q) && x.q !== 0);
    // Wallets often write every amount as positive and say the direction in its own column.
    if (buone.every(x => x.q > 0) && col.verso >= 0) {
        for (const x of buone) if (/out|sent|send|pay|uscit|spes/i.test(x.verso)) x.q = -x.q;
    }
    const usate = [['data', col.data], ['importo', [msat, sat, btcCol, importo, entrate].find(i => i >= 0)], ['descrizione', col.descr], ['verso', col.verso], ['euro', valuta === 'BTC' ? col.fiat : -1]]
        .filter(([, i]) => i >= 0).map(([k, i]) => `${k} ← "${testa[i]}"`);
    return { righe: buone, scartate: lette.length - buone.length, usate };
}

function chiave(m) {
    return m.tipo === 'fiat'
        ? ['F', m.data, m.importo.toFixed(2), m.persona, m.conto, m.descrizione].join('|')
        : ['B', m.data, m.bitcoin.toFixed(8), m.euro.toFixed(2), m.persona].join('|');
}

function movimentiDaImport(f) {
    const fonte = FONTI[f.fonte];
    const p = trovaPortafoglio(f.persona, f.conto);
    const valuta = p ? p.valuta : fonte.valuta || 'EUR';
    const tipo = VALUTA[valuta];
    const a = analizzaImport(f.testo, valuta);
    const storia = tutti('fiat');
    const lista = regole();
    const nuovi = a.righe.map(x => {
        if (tipo === 'fiat') {
            // A description seen before brings back how it was filed.
            const prec = regolaPer(x.descr, lista) || (x.descr && storia.filter(s => s.descrizione.toLowerCase() === x.descr.toLowerCase()).sort((s, t) => t.data.localeCompare(s.data))[0]);
            return { tipo, id: nuovoId(), data: x.data, persona: f.persona.trim(), conto: f.conto.trim(), importo: Math.round(x.q * 100) / 100,
                tipologia: prec?.tipologia || '', categoria: prec ? prec.categoria || categoriaPer(prec) : '', descrizione: x.descr, euro: 0, bitcoin: 0, prezzo: null };
        }
        const eur = Number.isFinite(x.fiat) ? Math.sign(x.q) * Math.abs(x.fiat) : 0;
        return { tipo, id: nuovoId(), data: x.data, persona: f.persona.trim(), conto: f.conto.trim(), importo: 0, tipologia: '', categoria: '',
            descrizione: x.descr, euro: eur, bitcoin: x.q, prezzo: eur && x.q ? Math.abs(eur / x.q) : null };
    });
    // Imported again, an export adds only what is not there yet (counting repeats).
    const presenti = new Map();
    for (const m of tutti(tipo).filter(m => stesso(m.conto, f.conto) && stesso(m.persona, f.persona))) {
        const k = chiave({ ...m, conto: f.conto.trim(), persona: f.persona.trim() });
        presenti.set(k, (presenti.get(k) || 0) + 1);
    }
    const daAggiungere = nuovi.filter(m => {
        const n = presenti.get(chiave(m)) || 0;
        if (n > 0) { presenti.set(chiave(m), n - 1); return false; }
        return true;
    });
    return { tipo, valuta, analisi: a, daAggiungere, gia: nuovi.length - daAggiungere.length };
}

function foglioImporta(f) {
    const fonte = FONTI[f.fonte];
    let anteprima = '';
    let esito = null;
    if (f.testo != null && f.conto.trim() && f.persona.trim()) {
        try {
            esito = movimentiDaImport(f);
            const r = esito.daAggiungere;
            const date = r.map(m => m.data).sort();
            const tot = r.reduce((s, m) => s + (esito.tipo === 'fiat' ? m.importo : m.bitcoin), 0);
            anteprima = `<div class="scheda" style="margin-bottom:0.75rem">
                <small>${esc(f.nomeFile || 'File')}</small>
                <strong>${r.length} movimenti nuovi</strong>
                <p class="nota" style="margin:0.3rem 0 0">${date.length ? `dal ${new Date(`${date[0]}T12:00:00`).toLocaleDateString('it-IT')} al ${new Date(`${date.at(-1)}T12:00:00`).toLocaleDateString('it-IT')} · totale ${esito.tipo === 'fiat' ? euro(tot) : btc(tot)}<br>` : ''}${esito.gia ? `${esito.gia} già presenti, ` : ''}${esito.analisi.scartate ? `${esito.analisi.scartate} righe illeggibili, ` : ''}colonne: ${esc(esito.analisi.usate.join(', '))}</p>
            </div>`;
        } catch (e) {
            anteprima = `<p class="errore">${esc(e.message)}</p>`;
        }
    }
    const esistente = trovaPortafoglio(f.persona, f.conto);
    const valutaConto = esistente ? esistente.valuta : fonte.valuta || 'EUR';
    const conti = [...new Set([fonte.conto, ...nomiPortafogli(VALUTA[valutaConto], f.persona)].filter(Boolean))];
    return `
        <h2>Importa movimenti<button class="icona" data-az="chiudi" aria-label="Chiudi">✕</button></h2>
        <p class="nota">Bozza: le colonne sono riconosciute dal nome e non le ho ancora provate su un export vero. Controlla l'anteprima prima di confermare.</p>
        <div class="campo"><label>Da dove</label>
            <div class="chips">${Object.entries(FONTI).map(([k, x]) => `<button class="chip${x.valuta === 'BTC' ? ' btc' : ''}${f.fonte === k ? ' attivo' : ''}" data-az="fonte" data-val="${k}">${esc(x.nome)}</button>`).join('')}</div>
            <p class="nota">${esc(fonte.nota)}</p>
        </div>
        <div class="campo"><label>Di chi</label>${chips('persona', persone(), f.persona)}</div>
        <div class="campo"><label>Nel portafoglio</label>
            <input data-campo="conto" list="l-conto" value="${esc(f.conto)}" autocomplete="off">${lista('l-conto', conti)}${chips('conto', conti, f.conto, valutaConto === 'BTC')}
            ${f.conto.trim() && !esistente ? `<p class="nota">${esc(f.persona)} non ha ancora questo portafoglio: lo creo in ${valutaConto === 'BTC' ? 'bitcoin' : 'euro'}.</p>` : ''}
        </div>
        <div class="campo"><label>File</label><input type="file" accept=".csv,text/csv,text/plain,text/comma-separated-values" data-file="import"></div>
        ${anteprima}
        <button class="bottone${valutaConto === 'BTC' ? ' btc' : ''}" data-az="conferma-import" ${esito?.daAggiungere.length ? '' : 'disabled'}>${esito?.daAggiungere.length ? `Importa ${esito.daAggiungere.length} movimenti` : 'Importa'}</button>
    `;
}

function confermaImport() {
    const f = S.foglio;
    const fonte = FONTI[f.fonte];
    if (!trovaPortafoglio(f.persona, f.conto)) creaPortafoglio(f.persona, f.conto, fonte.valuta || 'EUR', fonte.rete);
    const { daAggiungere } = movimentiDaImport(f);
    const p = trovaPortafoglio(f.persona, f.conto);
    const perAnno = new Map();
    for (const m of daAggiungere) perAnno.set(m.data.slice(0, 4), [...(perAnno.get(m.data.slice(0, 4)) || []), { ...m, conto: p.nome, persona: p.persona }]);
    for (const [anno, nuovi] of perAnno) cambiaAnno(p, anno, r => [...r, ...nuovi]);
    chiudiFoglio();
    S.conto = p.nome;
    S.persona = p.persona;
    S.tab = p.tipo === 'fiat' ? 'movimenti' : 'bitcoin';
    avvisa(`${daAggiungere.length} movimenti importati in ${p.cartella}`);
}

// Keeps what has been typed when the sheet is drawn again (a chip tapped, the direction switched).
function leggiBozza() {
    const f = S.foglio;
    if (!f) return;
    const dest = f.tipo === 'importa' ? f : f.bozza;
    if (!dest) return;
    document.querySelectorAll('#foglio input[data-campo]').forEach(i => { dest[i.dataset.campo] = i.value; });
}

function salvaFoglio() {
    leggiBozza();
    const f = S.foglio;
    const v = f.bozza;
    const vecchio = f.mov;
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.data)) throw new Error('Data non valida');
        if (!v.persona.trim()) throw new Error('Manca la persona');
        if (!v.conto.trim()) throw new Error('Manca il portafoglio');
        let m;
        if (f.tipo === 'fiat') {
            const n = numero(v.importo);
            if (!n) throw new Error("Scrivi l'importo: negativo se è una spesa");
            m = {
                tipo: 'fiat', id: vecchio?.id || nuovoId(), data: v.data, persona: v.persona.trim(), conto: v.conto.trim(),
                importo: n, tipologia: v.tipologia.trim(), categoria: v.categoria.trim(),
                descrizione: v.descrizione.trim(), euro: 0, bitcoin: 0, prezzo: null,
            };
        } else {
            const conSegnoQ = satsDa(v.quanti) / 1e8;
            if (!conSegnoQ) throw new Error('Scrivi quanti sats: negativi se escono');
            const s = conSegnoQ < 0 ? -1 : 1, q = Math.abs(conSegnoQ);
            // Euro are worked out at the price of that day and saved, unless typed in by hand.
            let e = Math.abs(numero(v.euro));
            if (!(e > 0)) { const p = prezzoNoto(v.data); e = p ? Math.round(q * p * 100) / 100 : 0; }
            m = {
                tipo: 'bitcoin', id: vecchio?.id || nuovoId(), data: v.data, persona: v.persona.trim(), conto: v.conto.trim(),
                importo: 0, tipologia: '', categoria: '', descrizione: v.descrizione.trim(),
                euro: s * e, bitcoin: s * q, prezzo: e > 0 ? e / q : null,
            };
        }
        salvaMovimento(m, vecchio);
        if (m.tipo === 'fiat' && !vecchio) S.mese = m.data.slice(0, 7);
        chiudiFoglio();
        disegna();
        avvisa(vecchio ? 'Modifica salvata' : 'Movimento salvato');
    } catch (e) {
        f.errore = e.message;
        disegnaFoglio();
    }
}

// ---------- events ----------

const azioni = {
    tab: v => { S.tab = v; window.scrollTo(0, 0); },
    mese: v => { S.mese = spostaMese(S.mese, Number(v)); S.calGiorno = ''; },
    'vista-mov': v => { S.vistaMov = v; },
    'cal-colore': v => { S.calColore = v; },
    'mostra-zero': () => { S.mostraZero = !S.mostraZero; },
    'cal-scala': v => { S.calScala = v; S.calSettimana = ''; },
    'cal-settimana': v => { S.calSettimana = spostaGiorni(lunediDi(S.calSettimana || oggiNelMese()), Number(v) * 7); S.mese = S.calSettimana.slice(0, 7); },
    'btc-periodo': v => { S.btcPeriodo = v; S.btcScelto = ''; },
    'btc-scegli': v => { S.btcScelto = S.btcScelto === v ? '' : v; },
    'cal-giorno': v => { S.calGiorno = v; },
    anno: v => { S.anno += Number(v); },
    'scegli-mese': v => { S.mese = v; S.vistaCat = 'mese'; },
    'vista-cat': v => { S.vistaCat = v; },
    cat: v => { S.catAperta = S.catAperta === v ? '' : v; },
    persona: v => { S.persona = v; },
    conto: v => { S.conto = v; },
    'bol-periodo': v => { S.bolPeriodo = v; S.bolScelto = ''; },
    'bol-tipo': v => { S.bolTipo = v; window.scrollTo(0, 0); },
    'bol-scegli': v => { S.bolScelto = v; },
    'apri-conto': (v, el) => {
        const p = trovaPortafoglio(el.dataset.persona, v);
        chiudiFoglio();
        S.conto = v;
        S.persona = el.dataset.persona;
        S.tab = p?.tipo === 'bitcoin' ? 'bitcoin' : 'movimenti';
        window.scrollTo(0, 0);
    },
    prezzo: () => { aggiornaPrezzo(); avvisa('Aggiorno il prezzo…'); return false; },
    nuovo: () => { apriFoglio({ tipo: S.tab === 'bitcoin' ? 'bitcoin' : S.tab === 'movimenti' ? 'fiat' : 'aggiungi' }); return false; },
    'nuovo-tipo': v => { chiudiFoglio(); apriFoglio({ tipo: v }); return false; },
    vai: v => { chiudiFoglio(); S.tab = v; window.scrollTo(0, 0); },
    apri: (v, el) => { apriFoglio({ tipo: el.dataset.tipo, mov: trova(el.dataset.tipo, el.dataset.id) }); return false; },
    impostazioni: () => { apriFoglio({ tipo: 'impostazioni' }); return false; },
    menu: () => { apriFoglio({ tipo: 'menu' }); return false; },
    'nuovo-portafoglio': v => {
        apriFoglio({ tipo: 'portafoglio', bozza: v ? { nome: '', valuta: v === 'fiat' ? 'EUR' : 'BTC', strato: v === 'fiat' ? 'cold' : v, persona: S.persona || pref.io } : null });
        return false;
    },
    strato: v => { S.strato = v; apriFoglio({ tipo: 'piano' }); return false; },
    'cfg-piramide': () => {
        const c = statoPiramide().cfg;
        apriFoglio({ tipo: 'piramide', bozza: { hot: c.hot, ln: c.ln, mesi: c.mesi, fiatMax: c.fiatMax } });
        return false;
    },
    'scegli-setup': () => { apriFoglio({ tipo: 'setup' }); return false; },
    'info-setup': v => { apriFoglio({ tipo: 'infosetup', setup: v }); return false; },
    'usa-setup': v => {
        try { usaSetup(v); } catch (e) { avvisa(e.message); return false; }
        chiudiFoglio();
        avvisa(v === 'auto' ? 'Profilo automatico' : `Profilo: ${SETUP[v].nome}`);
        return true;
    },
    sync: () => { apriFoglio({ tipo: 'sync' }); return false; },
    tutorial: () => { avviaTour(); return false; },
    'tour-avanti': () => { avantiTour(); return false; },
    'tour-salta': () => { chiudiTour(); return false; },
    'mesi-cuscinetto': v => { leggiBozza(); S.foglio.bozza.mesi = Number(v); disegnaFoglio(); return false; },
    'fiat-max': v => { leggiBozza(); S.foglio.bozza.fiatMax = !!v; disegnaFoglio(); return false; },
    'salva-piramide': () => {
        leggiBozza();
        const f = S.foglio, b = f.bozza;
        const hot = Number(String(b.hot).replace(',', '.')), ln = Number(String(b.ln).replace(',', '.'));
        if (!Number.isFinite(hot) || hot < 0 || hot > HOT_MAX) { f.errore = `L’hot wallet va da 0 a ${HOT_MAX}%`; disegnaFoglio(); return false; }
        if (!Number.isFinite(ln) || ln < 0 || ln > LN_MAX) { f.errore = `Lightning va da 0 a ${LN_MAX} €`; disegnaFoglio(); return false; }
        try { salvaConfigPiramide({ setup: 'mio', hot, ln, mesi: b.mesi, fiatMax: !!b.fiatMax }); } catch (e) { f.errore = e.message; disegnaFoglio(); return false; }
        chiudiFoglio();
        avvisa('Piramide personalizzata');
        return true;
    },
    'livello-wallet': (v, el) => { apriFoglio({ tipo: 'livello', persona: el.dataset.persona, nome: v }); return false; },
    'metti-strato': v => {
        const f = S.foglio, p = trovaPortafoglio(f.persona, f.nome);
        try { cambiaStrato(p, v); } catch (e) { avvisa(e.message); return false; }
        chiudiFoglio();
        S.strato = v;
        avvisa(`${p.nome} → ${STRATI[v].nome}`);
        return true;
    },
    'vedi-movimenti': () => {
        const f = S.foglio;
        S.conto = f.nome; S.persona = f.persona; S.tab = 'bitcoin';
        chiudiFoglio();
        window.scrollTo(0, 0);
        return true;
    },
    importa: () => { apriFoglio({ tipo: 'importa', fonte: 'bbva', persona: S.persona || pref.io, conto: 'BBVA', testo: null }); return false; },
    chiudi: () => { chiudiFoglio(); return false; },
    verso: v => {
        leggiBozza();
        const b = S.foglio.bozza;
        b.uscita = v === 'u';
        if (S.foglio.tipo === 'fiat') b.importo = conSegno(b.importo, b.uscita);
        else b.quanti = conSegno(b.quanti, b.uscita);
        disegnaFoglio();
        return false;
    },
    valuta: v => { leggiBozza(); S.foglio.bozza.valuta = v; disegnaFoglio(); return false; },
    'strato-nuovo': v => { leggiBozza(); S.foglio.bozza.strato = v; disegnaFoglio(); return false; },
    'crea-portafoglio': () => {
        leggiBozza();
        const b = S.foglio.bozza;
        try {
            const p = creaPortafoglio(b.persona, b.nome, b.valuta, b.strato);
            chiudiFoglio();
            avvisa(`Portafoglio ${p.cartella} creato`);
            return true;
        } catch (e) {
            S.foglio.errore = e.message;
            disegnaFoglio();
            return false;
        }
    },
    fonte: v => {
        leggiBozza();
        const f = S.foglio;
        f.fonte = v;
        if (FONTI[v].conto) f.conto = trovaPortafoglio(f.persona, FONTI[v].conto)?.nome || FONTI[v].conto;
        disegnaFoglio();
        return false;
    },
    'conferma-import': () => {
        try { confermaImport(); return true; } catch (e) { avvisa(e.message); return false; }
    },
    metti: (v, el) => {
        const campo = el.dataset.campo;
        if (campo === 'io') { pref.io = v; disegnaFoglio(); return true; }
        leggiBozza();
        if (S.foglio.tipo === 'importa') S.foglio[campo] = v;
        else S.foglio.bozza[campo] = v;
        if (campo === 'tipologia') S.foglio.bozza.daRegola = false;
        if (campo === 'tipologia') suggerisciCategoria();
        disegnaFoglio();
        return false;
    },
    salva: () => { salvaFoglio(); return false; },
    regole: (v, el) => {
        leggiBozza();
        const b = S.foglio?.tipo === 'fiat' ? S.foglio.bozza : null;
        apriFoglio({ tipo: 'regole', bozza: b ? { testo: (b.descrizione || '').trim().toLowerCase(), tipologia: daClassificare(b) ? '' : b.tipologia, categoria: stesso(b.categoria, 'Da classificare') ? '' : b.categoria } : null });
        return false;
    },
    'aggiungi-regola': () => {
        leggiBozza();
        const f = S.foglio, b = f.bozza;
        const testo = b.testo.trim(), tipologia = b.tipologia.trim(), categoria = b.categoria.trim() || categoriaPer({ tipologia });
        if (testo.length < 3) { f.errore = 'Scrivi almeno 3 lettere da cercare nella descrizione'; disegnaFoglio(); return false; }
        if (!tipologia) { f.errore = 'Scegli la tipologia'; disegnaFoglio(); return false; }
        const lista = regole().filter(x => !stesso(x.testo, testo));
        try { salvaRegole([{ testo, tipologia, categoria }, ...lista]); } catch (e) { f.errore = e.message; disegnaFoglio(); return false; }
        const n = applicaRegole();
        f.bozza = { testo: '', tipologia: '', categoria: '' }; f.errore = '';
        disegna(); disegnaFoglio();
        avvisa(n ? `Regola salvata: ${n} movimenti classificati` : 'Regola salvata');
        return false;
    },
    'togli-regola': v => { const l = regole(); l.splice(Number(v), 1); salvaRegole(l); disegnaFoglio(); return false; },
    'sposta-regola': v => { const l = regole(), i = Number(v); [l[i - 1], l[i]] = [l[i], l[i - 1]]; salvaRegole(l); disegnaFoglio(); return false; },
    'applica-regole': () => { const n = applicaRegole(); disegna(); disegnaFoglio(); avvisa(`${n} movimenti classificati`); return false; },
    'da-descrizione': v => { leggiBozza(); S.foglio.bozza.testo = v.toLowerCase(); disegnaFoglio(); document.querySelector('#foglio [data-campo=testo]')?.focus(); return false; },
    elimina: () => {
        const m = S.foglio.mov;
        if (!confirm('Eliminare questo movimento?')) return false;
        try {
            eliminaMovimento(m);
            chiudiFoglio();
            avvisa('Movimento eliminato');
        } catch (e) {
            avvisa(e.message);
        }
        return true;
    },
    unita: v => { pref.unita = v; disegnaFoglio(); },
    ricarica: () => { S.file = {}; carica(); aggiornaPrezzo(); if (S.foglio?.tipo === 'menu') chiudiFoglio(); else disegnaFoglio(); avvisa('File riletti'); },
    permesso: () => { A.chiediPermesso(); return false; },
    cartella: () => { A.scegliCartella(); return false; },
    io: v => { pref.io = v; },
    inizia: () => {
        scriviLocale('bilancio.avviato', true);
        carica();
        aggiornaPrezzo();
        S.tab = 'home';
        if (!leggiLocale('bilancio.tour', false)) setTimeout(avviaTour, 300);
    },
};

document.addEventListener('click', e => {
    const el = e.target.closest('[data-az]');
    if (!el) return;
    const fai = azioni[el.dataset.az];
    if (!fai) return;
    e.preventDefault();
    if (fai(el.dataset.val ?? '', el) !== false) disegna();
});

// The category follows the type, as the old sheet's lookup did, unless one was typed by hand.
function suggerisciCategoria() {
    const b = S.foglio.bozza;
    const fiat = tutti('fiat');
    const auto = new Set(fiat.map(x => x.categoria));
    const proposta = perUso(fiat.filter(x => x.tipologia === b.tipologia).map(x => x.categoria))[0];
    if (proposta && (!b.categoria || auto.has(b.categoria))) b.categoria = proposta;
}

document.addEventListener('input', e => {
    const campo = e.target.dataset?.campo;
    if (!campo) return;
    if (campo === 'cerca') { S.cerca = e.target.value; disegna(); return; }
    if (campo === 'io' && !S.foglio) { pref.io = e.target.value.trim(); disegna(); return; }
    if (!S.foglio) return;
    if (S.foglio.tipo === 'fiat' && campo === 'descrizione') {
        const b = S.foglio.bozza, x = regolaPer(e.target.value);
        if (x && b && (!b.tipologia || b.daRegola)) {
            b.tipologia = x.tipologia; b.categoria = categoriaPer(x); b.daRegola = true;
            const t = document.querySelector('#foglio [data-campo=tipologia]'), c = document.querySelector('#foglio [data-campo=categoria]');
            if (t) t.value = b.tipologia;
            if (c) c.value = b.categoria;
        }
    }
    if (S.foglio.tipo === 'fiat' && campo === 'tipologia' && S.foglio.bozza) S.foglio.bozza.daRegola = false;
    if (S.foglio.tipo === 'regole' && campo === 'testo') {
        const t = e.target.value.trim().toLowerCase(), el = document.querySelector('[data-prova]');
        if (el) el.textContent = t ? `${tutti('fiat').filter(m => daClassificare(m) && m.descrizione.toLowerCase().includes(t)).length} movimenti da classificare la contengono` : ' ';
    }
    if ((S.foglio.tipo === 'fiat' && campo === 'importo') || (S.foglio.tipo === 'bitcoin' && campo === 'quanti')) {
        const uscita = /^\s*[-−]/.test(e.target.value);
        if (S.foglio.bozza) S.foglio.bozza.uscita = uscita;
        document.querySelectorAll('#foglio .interruttore [data-az=verso]').forEach(b => b.classList.toggle('attivo', (b.dataset.val === 'u') === uscita));
    }
    if (S.foglio.tipo === 'bitcoin' && (campo === 'euro' || campo === 'quanti' || campo === 'data')) {
        leggiBozza();
        const b = S.foglio.bozza;
        if (campo === 'data' && !(b.data in storico)) prezzoDel(b.data).then(aggiornaControvalore);
        aggiornaControvalore();
    }
});

document.addEventListener('change', e => {
    if (e.target.dataset?.file === 'import' && S.foglio?.tipo === 'importa') {
        const file = e.target.files?.[0];
        if (!file) return;
        leggiBozza();
        const r = new FileReader();
        r.onload = () => { S.foglio.testo = String(r.result || ''); S.foglio.nomeFile = file.name; disegnaFoglio(); };
        r.onerror = () => avvisa('Non riesco a leggere il file');
        r.readAsText(file);
        return;
    }
    const campo = e.target.dataset?.campo;
    if (!S.foglio || !campo) return;
    if (S.foglio.tipo === 'importa' && (campo === 'conto' || campo === 'persona')) { leggiBozza(); disegnaFoglio(); return; }
    if (S.foglio.tipo !== 'fiat') return;
    leggiBozza();
    const b = S.foglio.bozza;
    if (campo === 'descrizione' && b.descrizione && !S.foglio.mov) {
        // A description already used brings back how it was filed last time.
        const ultimo = tutti('fiat').filter(x => x.descrizione.toLowerCase() === b.descrizione.toLowerCase())
            .sort((x, y) => y.data.localeCompare(x.data))[0];
        if (ultimo) {
            if (!b.tipologia) b.tipologia = ultimo.tipologia;
            if (!b.categoria) b.categoria = ultimo.categoria;
            b.conto = ultimo.conto || b.conto;
            disegnaFoglio();
        }
    } else if (campo === 'tipologia') {
        suggerisciCategoria();
        disegnaFoglio();
    } else if (campo === 'persona') {
        disegnaFoglio();
    }
});

// Called by the activity.
window.indietro = () => {
    if (tour) { chiudiTour(); return true; }
    if (S.foglio) { chiudiFoglio(); return true; }
    if (pronto() && S.conto) { S.conto = ''; S.persona = ''; disegna(); return true; }
    if (pronto() && S.tab === 'bollette' && S.bolTipo) { S.bolTipo = ''; disegna(); return true; }
    if (pronto() && S.tab !== 'home') { S.tab = 'home'; disegna(); return true; }
    return false;
};

window.alRitorno = () => {
    if (A.permesso() && A.cartella()) carica();
    if (pronto() && (!S.prezzo || Date.now() - S.prezzo.ts > 2 * 60 * 1000)) aggiornaPrezzo();
    // Back from the file picker the sheet is still the one the user is filling in.
    if (S.foglio?.tipo === 'importa') return;
    disegna();
    if (S.foglio?.tipo === 'impostazioni') disegnaFoglio();
};

window.cartellaScelta = percorso => {
    if (!percorso) { avvisa('Questa cartella non si può usare: scegline una nella memoria del telefono.'); return; }
    // Picking Bilancio instead of Bilancio/dati is the obvious slip, so it is forgiven.
    A.impostaCartella(percorso);
    const dentro = (sub, nome) => (sub ? `${sub}/${nome}` : nome);
    const haPortafogli = sub => elenco(sub).some(d => d.dir && (d.nome === 'fiat' || d.nome === 'bitcoin'
        || elenco(dentro(sub, d.nome)).some(c => c.dir && elenco(dentro(sub, `${d.nome}/${c.nome}`)).some(f => f.nome === 'portafoglio.json'))));
    if (!haPortafogli('') && elenco('').some(d => d.dir && d.nome === 'dati') && haPortafogli('dati')) A.impostaCartella(`${percorso}/dati`);
    S.file = {};
    carica();
    disegna();
    if (S.foglio?.tipo === 'impostazioni') disegnaFoglio();
};

if (A.permesso() && A.cartella()) carica();
disegna();
if (pronto()) aggiornaPrezzo();
// Whoever updates from a version without the tutorial sees it once too.
if (pronto() && !leggiLocale('bilancio.tour', false)) setTimeout(avviaTour, 400);
