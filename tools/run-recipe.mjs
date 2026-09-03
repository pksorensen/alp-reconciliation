#!/usr/bin/env node
// Kører en browseropskrift på den delte pks-agent-browser og henter det den
// producerer ned. Ingen model, ingen planlægger: motoren i den anden ende kører
// de trin der står i filen, og det her er klienten der fortæller hvad der sker.
//
// Værktøjet er delt i to faser med vilje, fordi den ene ting kørslen ikke kan
// selv er MitID:
//
//   node run-recipe.mjs --phase start  …   → kører til den parkerer, og STOPPER
//   node run-recipe.mjs --phase resume …   → venter kørslen færdig og henter filerne
//
// Mellem de to kald sender stationen sin notifikation. Det er hele grunden til
// opdelingen: en agent der sad og pollede kunne ikke sende noget imens, og en
// notifikation der kom efter godkendelsen ville være ubrugelig. `--phase run`
// gør begge dele i én proces og er den man bruger i hånden.
//
// Sessionen overlever mellem faserne, fordi kørslen er et verbum på sessionen og
// ikke et objekt for sig: `start` efterlader den åben og skriver dens id i
// tilstandsfilen, `resume` samler den op.
//
//   BROWSER_URL     fx https://browser.agentics.dk   (påkrævet)
//   BROWSER_TOKEN   statisk API-token — reserven, når vi ikke kører som et job
//                   (BROWSER_API_TOKEN accepteres også)
//   MITID_USER_ID   bruger-id'et til MitID. Se README: det står aldrig i opskriften.
//
// Adgangen kommer helst fra føderationen. Kører det her som et job på en linje,
// har runneren allerede givet os AGENTICS_TOKEN og AGENTICS_JOB_ID, og platformen
// veksler dem til et 5-minutters token udstedt til netop denne browser-service.
// Så er der ingen langlivet hemmelighed i containeren overhovedet.
//
// Afhængighedsfri: `fetch` er indbygget fra Node 18.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const all = (n) => argv.reduce((acc, v, i) => (v === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const die = (msg) => { console.error(msg); process.exit(1); };

// En variabel der stadig står som `${localEnv:…}` er en devcontainer-substitution
// der ikke skete. Behandl den som tom, ellers sender vi teksten som token, får 401,
// og et opsætningsproblem ligner en fejl i dagens arbejde.
const env = (name) => {
    const v = process.env[name];

    return !v || /^\$\{.*\}$/.test(v.trim()) ? '' : v;
};

const PHASE = arg('phase', 'run');
if (!['start', 'resume', 'run'].includes(PHASE)) die(`--phase skal være start, resume eller run — ikke "${PHASE}".`);

const BASE = (arg('server', env('BROWSER_URL'))).replace(/\/+$/, '');
if (!BASE) die('BROWSER_URL er ikke sat, og --server blev ikke givet.');

// Projektets egen `config.json` bærer alt det kundespecifikke — aftalenavn, periode,
// formater. Det står dér og ikke i opskriften, fordi opskriften ligger i et offentligt
// repo og aftalenavnet er kundens.
const CONFIG = arg('config', '');
const config = CONFIG ? JSON.parse(await readFile(resolve(CONFIG), 'utf8')) : {};

const RECIPE = resolve(arg('recipe', join(ROOT, 'recipes', `${config.bank ?? 'spard'}.json`)));
const OUT = resolve(arg('out', 'downloads'));
const STATE = resolve(arg('state', join(process.env.TMPDIR || '/tmp', 'alp-reconciliation-run.json')));
const PROFILE = arg('persist-profile', config.persistProfile ?? 'bank');
const TTL_MINUTES = Number(arg('ttl-minutes', '90'));
const WAIT_FOR_DATA_MS = Number(arg('wait-for-data-ms', '90000'));

// ---------------------------------------------------------------- adgang

async function federatedToken() {
    const agentics = env('AGENTICS_BASE_URL').replace(/\/+$/, '');
    const runnerToken = env('AGENTICS_TOKEN');
    const jobId = env('AGENTICS_JOB_ID');
    const owner = env('AGENTICS_OWNER');
    const project = env('AGENTICS_PROJECT_NAME');
    if (!agentics || !runnerToken || !jobId || !owner || !project) return null;

    const url = `${agentics}/api/owners/${encodeURIComponent(owner)}/projects/${encodeURIComponent(project)}/federation/token`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${runnerToken}` },
        // Kørslen har brug for hele /v1/sessions-fladen, og bagefter for at hente
        // sine egne artefakter ned. Begge scopes skal stå i ejerens tillidsbinding
        // hos browser-servicen, ellers afvises tokenet dér og ikke her.
        body: JSON.stringify({ audience: BASE, scope: ['browser:sessions', 'browser:artifacts:read'], jobId }),
    }).catch((e) => { console.log(`Kunne ikke nå ${url}: ${e.message}`); return null; });
    if (!res) return null;
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.log(`Fødereret token afvist (${res.status}): ${detail.slice(0, 200)}`);

        return null;
    }
    const body = await res.json().catch(() => ({}));

    return body.access_token || null;
}

const staticToken = env('BROWSER_TOKEN') || env('BROWSER_API_TOKEN');
let current = await federatedToken();
const federated = Boolean(current);
let mintedAt = Date.now();
if (!current) current = staticToken;
if (!current) die('Ingen adgang til browser-servicen: hverken fødereret veksling eller BROWSER_TOKEN.');

/**
 * Det fødererede token lever **fem minutter**. En kørsel gør ikke: et menneske skal
 * finde sin telefon frem, og bankens eksport tager 26-68 sekunder pr. fil. Hentes
 * tokenet én gang ved procesopstart, er det udløbet præcis dér hvor filerne skal
 * hentes ned — og en 401 dér ligner en fejl i opskriften. Så veksl igen inden det
 * bliver gammelt. Et statisk BROWSER_TOKEN udløber ikke og røres ikke.
 */
async function token() {
    if (federated && Date.now() - mintedAt > 4 * 60_000) {
        const fresh = await federatedToken();
        if (fresh) {
            current = fresh;
            mintedAt = Date.now();
            console.log(`… fornyede fødereret token ${new Date().toISOString().slice(11, 19)}`);
        } else if (staticToken) {
            console.log('… fødereret fornyelse mislykkedes — falder tilbage på BROWSER_TOKEN');
            current = staticToken;
            mintedAt = Date.now();
        }
    }

    return current;
}

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ikke-json fejltekst */ }
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status} — ${(json?.error ?? text).slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }

    return json;
}

// ---------------------------------------------------------------- session

/**
 * Én session ad gangen pr. husket profil; nummer to får 409. Det er den rigtige
 * regel og den forkerte at stå og fejle på i en daglig kørsel: en session, der
 * blev efterladt åben af gårsdagens knækkede kørsel, ville låse profilen for
 * evigt. Så ryd op efter os selv og prøv én gang til.
 */
async function openSession() {
    const request = { profile: 'laptop', ttlMs: TTL_MINUTES * 60_000, persistProfile: PROFILE };
    try {
        return await api('POST', '/v1/sessions', request);
    } catch (e) {
        if (e.status !== 409) throw e;
        console.log(`Profilen "${PROFILE}" er optaget af en ældre session — lukker den.`);
        const { sessions = [] } = (await api('GET', '/v1/sessions')) ?? {};
        const stale = sessions.filter((s) => s.persistProfile === PROFILE);
        for (const s of stale) {
            await api('DELETE', `/v1/sessions/${s.id}`).catch((x) => console.log(`  kunne ikke lukke ${s.id}: ${x.message}`));
            console.log(`  lukkede ${s.id}`);
        }
        if (!stale.length) throw e;

        return api('POST', '/v1/sessions', request);
    }
}

async function closeSession(id) {
    if (!id) return null;

    return api('DELETE', `/v1/sessions/${id}`).catch((e) => {
        console.log(`Kunne ikke lukke session ${id}: ${e.message}`);

        return null;
    });
}

// ---------------------------------------------------------------- kørsel

const printedSteps = new Set();
const shownData = new Map();
let lastPrompt = null;

function printProgress(run) {
    // Nøglen er pladsen i listen, ikke trinnets id: `forEach` kører det samme id
    // én gang pr. element, og de skal alle skrives — men kun én gang hver, også
    // når `--phase run` kører begge faser i den samme proces.
    (run?.steps ?? []).forEach((s, i) => {
        const key = `${i}:${s.stepId}`;
        if (printedSteps.has(key)) return;
        printedSteps.add(key);
        const glyph = s.state === 'ok' ? 'OK  ' : s.state === 'skipped' ? '--  ' : 'FEJL';
        const note = (s.note ?? '').split('\n')[0].slice(0, 70);
        console.log(`${glyph} ${String(s.stepId).padEnd(18)} ${((s.ms ?? 0) / 1000).toFixed(1)}s  ${note}`);
    });
    if (run?.waiting) {
        const prompt = run.waiting.prompt ?? 'Kræver en handling';
        if (prompt !== lastPrompt) { lastPrompt = prompt; console.log(`VENTER  ${prompt}`); }
        for (const [k, v] of Object.entries(run.waiting.data ?? {})) {
            const text = v == null ? '' : String(v);
            if (!text.trim() || shownData.get(k) === text) continue;
            shownData.set(k, text);
            console.log(`        ${k}: ${text}`);
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Følger kørslen indtil `until` siger stop. Der er ingen strøm at abonnere på, så
 * det er polling — men den er kun til fremvisningen; motoren venter ikke på os.
 *
 * Hjerteslaget er ikke pynt. Runnerens idle timeout dræber en station der har
 * været tavs for længe, og et menneske der skal finde sin telefon frem er tavs i
 * flere minutter. En linje pr. halve minut er forskellen på en kørsel der venter
 * og en der bliver slået ihjel mens den venter.
 */
async function follow(sessionId, until, { heartbeat = true } = {}) {
    let last = Date.now();
    for (;;) {
        const run = await api('GET', `/v1/sessions/${sessionId}/run`);
        printProgress(run);
        if (until(run)) return run;
        if (heartbeat && Date.now() - last > 30_000) {
            last = Date.now();
            const s = run?.waiting ? 'venter på godkendelse' : `kører (${run?.steps?.length ?? 0} trin)`;
            console.log(`… ${new Date().toISOString().slice(11, 19)} ${s}`);
        }
        await sleep(1000);
    }
}

const terminal = (run) => run?.state === 'done' || run?.state === 'failed';

// ---------------------------------------------------------------- artefakter

function safeName(s) {
    return [...s].map((c) => (/[\p{L}\p{N}._-]/u.test(c) ? c : '-')).join('').split('-').filter(Boolean).join('-');
}

async function saveArtifacts(run, kind = 'download') {
    const list = (run?.artifacts ?? []).filter((a) => a.kind === kind);
    if (!list.length) return [];
    await mkdir(OUT, { recursive: true });
    const saved = [];
    for (const a of list) {
        const url = a.url?.startsWith('/') ? BASE + a.url : a.url;
        if (!url) continue;
        const res = await fetch(url, { headers: { authorization: `Bearer ${await token()}` } });
        if (!res.ok) { console.log(`Kunne ikke hente ${a.id ?? url}: HTTP ${res.status}`); continue; }
        const filename = a.labels?.filename ?? `${kind}.bin`;
        const label = a.labels?.label;
        const name = label ? safeName(label) + extname(filename) : safeName(filename);
        const path = join(OUT, name);
        await writeFile(path, Buffer.from(await res.arrayBuffer()));
        saved.push(path);
        console.log(`ned  ${path} (${a.bytes ?? '?'} B)`);
    }

    return saved;
}

// ---------------------------------------------------------------- faser

async function readState() {
    if (!existsSync(STATE)) die(`Ingen tilstandsfil i ${STATE}. Kør --phase start først.`);

    return JSON.parse(await readFile(STATE, 'utf8'));
}

async function phaseStart() {
    const raw = JSON.parse(await readFile(RECIPE, 'utf8').catch((e) => die(`Kan ikke læse ${RECIPE}: ${e.message}`)));
    // Filen må gerne være enten `{recipe, params}` eller bare opskriften selv.
    const payload = raw.recipe ? raw : { recipe: raw };
    payload.params = { ...(payload.params ?? {}) };

    // Bruger-id'et er en KØRSELSPARAMETER, ikke en del af opskriften. Derfor står
    // det i miljøet (vault agent run sætter det) og aldrig i filen — en opskrift
    // med et bruger-id i er en opskrift man ikke kan lægge i et offentligt repo.
    for (const key of ['agreement', 'period', 'formats']) {
        if (config[key] !== undefined && key in (payload.recipe?.params ?? {})) payload.params[key] = config[key];
    }
    // Kun de parametre opskriften faktisk erklærer. Motoren afviser en ukendt
    // parameter med 400, og en opskrift uden MitID-trin skal kunne køre på det her
    // værktøj uden at arve et bruger-id, den ikke bad om.
    const declared = payload.recipe?.params ?? {};
    const mitid = env('MITID_USER_ID');
    if (mitid && 'mitidUserId' in declared) payload.params.mitidUserId = mitid;
    for (const pair of all('param')) {
        const i = pair.indexOf('=');
        if (i <= 0) die(`--param vil have KEY=VALUE, fik: ${pair}`);
        payload.params[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if ('mitidUserId' in declared && !payload.params.mitidUserId) {
        die('Opskriften kræver et MitID-bruger-id, og hverken MITID_USER_ID eller --param mitidUserId=… gav et.');
    }

    const session = await openSession();
    console.log(`session ${session.id} (${federated ? 'fødereret' : 'BROWSER_TOKEN'}, profil "${PROFILE}")`);
    await writeFile(STATE, JSON.stringify({ sessionId: session.id, base: BASE, startedAt: new Date().toISOString() }, null, 2));

    // Kan kørslen ikke startes, skal sessionen ikke blive stående: den holder den
    // huskede profil låst, og i morgen tidlig ville 409 være det første der skete.
    try {
        await api('POST', `/v1/sessions/${session.id}/run`, payload);
    } catch (e) {
        await closeSession(session.id);
        die(`Kørslen kunne ikke startes: ${e.message}`);
    }

    // Stop når kørslen parkerer — men vent lidt på engangskoden, hvis den er på vej.
    // Koden dukker først op når MitID-appen har åbnet forespørgslen, så den er ikke
    // altid der i samme sekund som ventetrinnet begynder. Uden det her sender vi en
    // notifikation uden kode, og så er den halvt så meget værd.
    let parkedAt = 0;
    const run = await follow(session.id, (r) => {
        if (terminal(r)) return true;
        if (!r?.waiting) return false;
        if (!parkedAt) parkedAt = Date.now();
        if (Object.values(r.waiting.data ?? {}).some((v) => String(v ?? '').trim())) return true;

        return Date.now() - parkedAt > WAIT_FOR_DATA_MS;
    });

    if (run?.state === 'failed') {
        console.log(`FEJL: ${run.error ?? 'ukendt'}`);
        await closeSession(session.id);

        return { outcome: 'failed' };
    }
    if (run?.state === 'done') {
        console.log('Kørslen blev færdig uden at spørge om noget — ingen notifikation nødvendig.');

        return { outcome: 'done', sessionId: session.id, run };
    }

    const data = Object.entries(run.waiting?.data ?? {}).filter(([, v]) => String(v ?? '').trim());
    // Sidste linje er maskinlæselig, så stationen kan bygge sin notifikation af den
    // uden at gætte på formatet af det ovenfor.
    console.log(`NOTIFY ${JSON.stringify({
        prompt: run.waiting?.prompt ?? 'Godkend login',
        data: Object.fromEntries(data),
        sessionId: session.id,
    })}`);

    return { outcome: 'waiting', sessionId: session.id };
}

async function phaseResume() {
    const state = await readState();
    const sessionId = state.sessionId;
    console.log(`samler session ${sessionId} op`);
    let code = 0;
    try {
        const run = await follow(sessionId, terminal);
        if (run?.state !== 'done') {
            console.log(`FEJL: ${run?.error ?? 'ukendt'}`);
            code = 2;
        } else {
            const saved = await saveArtifacts(run);
            console.log(`${saved.length} fil(er) i ${OUT}`);
            if (!saved.length) { console.log('FEJL: kørslen blev færdig uden at hente noget.'); code = 2; }
        }
    } finally {
        // Luk altid. En efterladt session holder den huskede profil låst, og den
        // næste morgen ville så fejle på 409 i stedet for at køre. Skal en knækket
        // kørsel inspiceres i browseren, gøres det med `pks browser recipe --keep`
        // i hånden — ikke ved at lade den daglige linje efterlade sessioner.
        await closeSession(sessionId);
    }
    process.exit(code);
}

if (PHASE === 'start') {
    const { outcome } = await phaseStart();
    process.exit(outcome === 'failed' ? 2 : 0);
} else if (PHASE === 'resume') {
    await phaseResume();
} else {
    const { outcome } = await phaseStart();
    // `run` er hånd-tilstanden: der er ingen der sender en notifikation imellem,
    // så den fortsætter selv. Blev kørslen færdig i første fase, er der intet at
    // samle op — det er en opskrift uden `human`-trin.
    if (outcome === 'failed') process.exit(2);
    await phaseResume();
}
