#!/usr/bin/env node
// Læser bankens eksportfiler og skriver dem ind i posteringsregnskabet.
//
// Regnskabet er almindelige filer i projektets eget repo, og det er et valg, ikke
// en mangel: en postering, der er committet, kan sammenlignes med gårsdagens med
// `git diff`, og en linje der pludselig ændrer sig er dermed synlig i stedet for
// at være en opdatering ingen kan se. En database ville skjule præcis dét.
//
//   <ledger>/postings/<konto>/<ÅÅÅÅ-MM>.jsonl   én postering pr. linje, sorteret
//   <ledger>/accounts.json                       konti, saldo og sidste postering
//   <ledger>/counterparties.json                 modparter og hvad de fylder
//   <ledger>/raw/<ÅÅÅÅ-MM-DD>/…                  eksporten som den blev hentet
//
// Kørslen er idempotent. Hver postering får et indhold-adresseret id (sha256 over
// konto, dato, tekst, beløb og saldo), og et id der allerede står i filen skrives
// ikke igen. Det er dét, der gør, at eksporten godt må dække tolv måneder hver
// eneste dag: overlappet forsvinder af sig selv, og en dag der mangler bliver
// samlet op af den næste kørsel i stedet for at være tabt.
//
//   node parse-exports.mjs --in ./downloads --ledger <mappe>
//
// Afhængighedsfri. Node 20+.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const die = (msg) => { console.error(msg); process.exit(1); };

const IN = resolve(arg('in', 'downloads'));
const ledgerArg = arg('ledger', '');
if (!ledgerArg) die('--ledger mangler: sig hvilken mappe i projektets repo regnskabet ligger i.');
const LEDGER = resolve(ledgerArg);
const TODAY = arg('date', new Date().toISOString().slice(0, 10));

if (!existsSync(IN)) die(`Ingen mappe med eksportfiler i ${IN}.`);

// ---------------------------------------------------------------- csv

/**
 * Bankens CSV har ingen overskriftsrække, er `;`-adskilt, står i UTF-8 med BOM og
 * bruger CRLF. Felterne er, i rækkefølge: dato (DD-MM-ÅÅÅÅ), tekst, beløb, saldo,
 * valuta, modpart. Der er ingen citationstegn i filen — men et felt der en dag
 * indeholder et semikolon ville ellers flytte alle de følgende felter én plads, så
 * splitningen respekterer citationstegn alligevel.
 */
function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') quoted = false;
            else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ';') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);

    return out;
}

/** "-37.400,00" → -37400.00. Punktum er tusindskilletegn, komma er decimal. */
function amount(raw) {
    const t = String(raw ?? '').trim().replace(/\./g, '').replace(',', '.');
    const n = Number(t);

    return Number.isFinite(n) ? n : null;
}

/** "03-09-2025" → "2025-09-03". Alt andet returneres uændret, så det kan ses i filen. */
function isoDate(raw) {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(raw ?? '').trim());

    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(raw ?? '').trim();
}

// æ/ø/å dekomponerer ikke i NFD, så de skal oversættes for sig — ellers bliver
// "overførsel" til "overf-rsel" og to skrivemåder af det samme navn til to nøgler.
const slug = (s) => [...String(s).toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')]
    .map((c) => (/[a-z0-9]/.test(c) ? c : '-')).join('').split('-').filter(Boolean).join('-');

/**
 * Kontoen kommer fra filnavnet, fordi den er dét eneste sted den står: bankens egne
 * filnavne er `eksport.csv` for hver eneste konto, og opskriftens mærkat er det, der
 * skiller dem ad. Endelsen `-CSV` er formatet, ikke en del af kontonavnet.
 */
function accountOf(file) {
    return basename(file, extname(file)).replace(/[-_ ]?(csv|pdf)$/i, '').replace(/-+$/, '');
}

/**
 * Modparten er sjældent et rent navn. Er sidste felt udfyldt, står navnet før det
 * første komma; ellers er posteringsteksten det bedste vi har. Nøglen er slug'et, så
 * "Padelstar" og "PADELSTAR " er den samme modpart — og feltet `name` bevarer den
 * skrivemåde banken brugte, så ingen tror vi har rettet i deres data.
 */
function counterpartyOf(text, details) {
    const source = (details || '').trim() || (text || '').trim();
    const name = source.split(/[,\\]/)[0].trim().replace(/\s+/g, ' ');
    if (!name) return null;
    // Referencenumre hører til posteringen, ikke til modparten. Uden det her bliver
    // hver eneste PBS-overførsel sin egen modpart, og registeret er så en liste over
    // transaktioner med ekstra trin — MÅLT: 201 "modparter" på 394 posteringer.
    const key = slug(name.replace(/\b\d{5,}\b/g, ' '));

    return key ? { key, name } : null;
}

function parseCsv(content, account) {
    const rows = [];
    for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const f = splitCsvLine(line);
        if (f.length < 4) continue;
        const date = isoDate(f[0]);
        const value = amount(f[2]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || value === null) continue;   // overskrift eller vrøvl
        const text = (f[1] ?? '').trim();
        const details = (f[5] ?? '').trim();
        const posting = {
            id: '',
            account,
            date,
            text,
            amount: value,
            balance: amount(f[3]),
            currency: (f[4] ?? 'DKK').trim() || 'DKK',
            ...(details ? { details } : {}),
        };
        const cp = counterpartyOf(text, details);
        if (cp) { posting.counterparty = cp.name; posting.counterpartyKey = cp.key; }
        // Saldoen er med i nøglen med vilje. To ens beløb til den samme modpart på
        // den samme dag er en helt normal ting (to træk på det samme kort), og uden
        // saldoen ville den anden af dem forsvinde som en dublet.
        posting.id = createHash('sha256')
            .update([account, date, text, value.toFixed(2), String(posting.balance)].join('|'))
            .digest('hex').slice(0, 16);
        rows.push(posting);
    }

    return rows;
}

// ---------------------------------------------------------------- regnskabet

async function readJsonl(path) {
    if (!existsSync(path)) return [];

    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const readJson = async (path, fallback) => (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : fallback);

const files = (await readdir(IN)).filter((f) => f.toLowerCase().endsWith('.csv'));
if (!files.length) die(`Ingen CSV-filer i ${IN}. Blev eksporten hentet?`);

const parsed = [];
for (const f of files) {
    const account = accountOf(f);
    const rows = parseCsv(await readFile(join(IN, f), 'utf8'), account);
    if (!rows.length) { console.log(`${f}: ingen posteringer — filen ser tom ud.`); continue; }
    parsed.push({ file: f, account, rows });
    console.log(`${f}: ${rows.length} posteringer på "${account}"`);
}
if (!parsed.length) die('Ingen af filerne indeholdt posteringer. Regnskabet er ikke rørt.');

// Råfilerne gemmes ved siden af. Kan en postering en dag ikke genkendes, er det den
// eneste måde at se, om banken ændrede formatet eller vi ændrede parseren.
const rawDir = join(LEDGER, 'raw', TODAY);
await mkdir(rawDir, { recursive: true });
for (const f of await readdir(IN)) await copyFile(join(IN, f), join(rawDir, f));

const accounts = await readJson(join(LEDGER, 'accounts.json'), {});
let added = 0;
let seen = 0;

for (const { account, rows } of parsed) {
    const dir = join(LEDGER, 'postings', slug(account));
    await mkdir(dir, { recursive: true });

    const byMonth = new Map();
    for (const r of rows) {
        const month = r.date.slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(r);
    }

    for (const [month, incoming] of byMonth) {
        const path = join(dir, `${month}.jsonl`);
        const existing = await readJsonl(path);
        const ids = new Set(existing.map((r) => r.id));
        const fresh = incoming.filter((r) => !ids.has(r.id));
        seen += incoming.length;
        added += fresh.length;
        if (!fresh.length) continue;
        // Sorteret på dato og derefter id, så en fil altid har den samme rækkefølge
        // uanset hvilken dag posteringen kom ind. Ellers ville `git diff` vise et
        // hav af flytninger hver morgen i stedet for de linjer der faktisk er nye.
        const merged = [...existing, ...fresh].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
        await writeFile(path, merged.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }

    const last = rows.reduce((a, b) => (b.date >= a.date ? b : a));
    accounts[slug(account)] = {
        name: account,
        currency: last.currency,
        balance: last.balance,
        lastPosting: last.date,
        updatedAt: TODAY,
    };
}

await writeFile(join(LEDGER, 'accounts.json'), JSON.stringify(accounts, null, 2) + '\n');

// Modpartsregisteret bygges fra hele regnskabet, ikke fra dagens fil, så tallene i
// det altid svarer til det der står i posteringerne — også efter en manuel rettelse.
const counterparties = {};
const postingsRoot = join(LEDGER, 'postings');
for (const accountDir of await readdir(postingsRoot).catch(() => [])) {
    for (const file of await readdir(join(postingsRoot, accountDir)).catch(() => [])) {
        for (const r of await readJsonl(join(postingsRoot, accountDir, file))) {
            if (!r.counterpartyKey) continue;
            const c = counterparties[r.counterpartyKey] ??= { name: r.counterparty, postings: 0, total: 0, first: r.date, last: r.date };
            c.postings++;
            c.total = Number((c.total + r.amount).toFixed(2));
            if (r.date < c.first) c.first = r.date;
            if (r.date > c.last) c.last = r.date;
        }
    }
}
await writeFile(join(LEDGER, 'counterparties.json'), JSON.stringify(counterparties, null, 2) + '\n');

const index = await readJson(join(LEDGER, 'index.json'), { imports: [] });
index.imports = [...(index.imports ?? []).slice(-364), { date: TODAY, files: parsed.map((p) => p.file), seen, added }];
index.accounts = Object.keys(accounts).length;
index.counterparties = Object.keys(counterparties).length;
await writeFile(join(LEDGER, 'index.json'), JSON.stringify(index, null, 2) + '\n');

console.log(`${added} nye posteringer af ${seen} læste. ${Object.keys(accounts).length} konti, ${Object.keys(counterparties).length} modparter.`);
console.log(`Regnskabet: ${LEDGER}`);
