import { ConvexHttpClient } from "convex/browser";

const convex = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL || "");

/* ============================================================
   CODE VISUALIZER PRO — ENHANCED ENGINE v2.0
   Supports: int, float, double, bool, char
             for / while / if-else
             cout, compound assignments, ++/--
   Detects:  undefined vars, div-by-zero, undeclared assign
   ============================================================ */

let instructions = [];     // compiled instruction tape
let ip = 0;     // instruction pointer
let memory = {};    // { name: { type, value, changed } }
let consoleOutput = [];
let runtimeErrors = [];
let parseErrors = [];
let currentLine = -1;
let intervalId = null;
let isFinished = false;

/* ─────────────────── TYPE UTILITIES ─────────────────── */

const NUMERIC_TYPES = ['int', 'long', 'short', 'unsigned'];
const FLOAT_TYPES = ['float', 'double'];
const ALL_TYPES = [...NUMERIC_TYPES, ...FLOAT_TYPES, 'bool', 'char'];

function defaultFor(type) {
    if (type === 'bool') return 'false';
    if (type === 'char') return "'\\0'";
    return '0';
}

function coerce(val, type) {
    if (val === undefined || val === null) return 0;
    if (NUMERIC_TYPES.includes(type)) return Math.trunc(Number(val));
    if (FLOAT_TYPES.includes(type)) return parseFloat(Number(val).toPrecision(7));
    if (type === 'bool') return Boolean(val);
    if (type === 'char') {
        if (typeof val === 'string') return val.charAt(0) || '\0';
        return String.fromCharCode(Math.trunc(Number(val)));
    }
    return val;
}

function fmtVal(val, type) {
    if (type === 'bool') return val ? 'true' : 'false';
    if (type === 'char') return `'${val}'`;
    if (FLOAT_TYPES.includes(type)) {
        const n = Number(val);
        return Number.isInteger(n) ? n.toFixed(1) : n.toString();
    }
    return String(val);
}

/* ─────────────────── EXPRESSION EVALUATOR ─────────────────── */

function evalExpr(expr) {
    let e = expr.trim();
    if (!e) return 0;

    // String literals → unwrap
    if (/^"[^"]*"$/.test(e)) return e.slice(1, -1);

    // Char literal
    if (/^'[^']{0,1}'$/.test(e)) return e.charAt(1);

    // C++ bool literals
    e = e.replace(/\btrue\b/g, '1').replace(/\bfalse\b/g, '0');

    // Substitute variables (longest-name first to avoid partial replacements)
    const sorted = Object.keys(memory).sort((a, b) => b.length - a.length);
    for (const v of sorted) {
        const rx = new RegExp(`\\b${v}\\b`, 'g');
        const mv = memory[v];
        if (mv.type === 'char') {
            e = e.replace(rx, `"${mv.value}"`);
        } else if (mv.type === 'bool') {
            e = e.replace(rx, mv.value ? '1' : '0');
        } else {
            e = e.replace(rx, mv.value);
        }
    }

    // Check for remaining unknown identifiers
    const ids = (e.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || []);
    const safe = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'endl', 'Math']);
    for (const id of ids) {
        if (!safe.has(id) && isNaN(Number(id))) {
            throw new Error(`Undefined variable: '${id}'`);
        }
    }

    // Detect divide-by-zero (simple check)
    if (/[/%]\s*0\b/.test(e)) throw new Error('Division by zero');

    try {
        // eslint-disable-next-line no-eval
        return eval(e);
    } catch {
        throw new Error(`Cannot evaluate: "${expr}"`);
    }
}

/* ─────────────────── BLOCK UTILITIES ─────────────────── */

function findBlockOpen(lines, from) {
    for (let i = from; i < lines.length; i++) {
        if (lines[i].includes('{')) return i;
    }
    return -1;
}

function findMatchingClose(lines, openLine) {
    let depth = 0;
    for (let i = openLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') depth++;
            else if (ch === '}') { if (--depth === 0) return i; }
        }
    }
    return lines.length - 1;
}

/* ─────────────────── COMPILER ─────────────────── */

function compile() {
    instructions = [];
    parseErrors = [];

    const lines = editor.getValue().split('\n');
    try {
        compileRange(lines, 0, lines.length - 1);
        instructions.push({ type: 'halt', line: lines.length - 1 });
    } catch (e) {
        parseErrors.push(e.message);
    }
}

function compileRange(lines, from, to) {
    let i = from;
    while (i <= to) {
        i = compileSingle(lines, i, to);
    }
}

/* Regex that recognises a *type identifier* and not a keyword */
const TYPE_RE = new RegExp(`^(${ALL_TYPES.join('|')})\\s`);

function compileSingle(lines, i, max) {
    const raw = lines[i] || '';
    const line = raw.trim();

    // ── Skippable lines ──────────────────────────────────────
    if (!line
        || line.startsWith('//')
        || line.startsWith('#')
        || line === '{' || line === '}'
        || /^using\s/.test(line)
        || /^return\s/.test(line) || line === 'return;'
        || /^[a-zA-Z_]\w*\s+[a-zA-Z_]\w*\s*\([^)]*\)\s*\{?\s*$/.test(line) // fn header
    ) {
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    // ── Variable declaration: type name = expr; ───────────────
    if (TYPE_RE.test(line)) {
        const m = line.match(
            new RegExp(`^(${ALL_TYPES.join('|')})\\s+(\\w+)\\s*(?:=\\s*(.+?))?\\s*;\\s*$`)
        );
        if (m) {
            instructions.push({
                type: 'declare', line: i,
                varType: m[1], varName: m[2],
                expr: m[3] !== undefined ? m[3] : defaultFor(m[1])
            });
            return i + 1;
        }
    }

    // ── Control structures ────────────────────────────────────
    if (/^for\s*\(/.test(line)) return compileFor(lines, i, max);
    if (/^while\s*\(/.test(line)) return compileWhile(lines, i, max);
    if (/^if\s*\(/.test(line)) return compileIf(lines, i, max);
    if (/^do\s*\{?/.test(line)) return compileDo(lines, i, max);

    // Orphan else (shouldn't appear under normal parsing)
    if (/^else/.test(line)) { instructions.push({ type: 'noop', line: i }); return i + 1; }

    // ── cout ─────────────────────────────────────────────────
    if (/^(std::)?cout\s*<</.test(line)) {
        const expr = line.replace(/^(std::)?cout\s*/, '').replace(/;\s*$/, '');
        instructions.push({ type: 'cout', line: i, expr });
        return i + 1;
    }

    // ── Increment / Decrement ─────────────────────────────────
    const post = line.match(/^(\w+)\s*(\+\+|--)\s*;\s*$/);
    if (post) { instructions.push({ type: 'incrdecr', line: i, varName: post[1], op: post[2] }); return i + 1; }
    const pre = line.match(/^(\+\+|--)\s*(\w+)\s*;\s*$/);
    if (pre) { instructions.push({ type: 'incrdecr', line: i, varName: pre[2], op: pre[1] }); return i + 1; }

    // ── Compound assignment: x += expr ───────────────────────
    const comp = line.match(/^(\w+)\s*(\+=|-=|\*=|\/=|%=)\s*(.+?)\s*;\s*$/);
    if (comp) {
        instructions.push({ type: 'compound', line: i, varName: comp[1], op: comp[2], expr: comp[3] });
        return i + 1;
    }

    // ── Simple assignment: x = expr ──────────────────────────
    const asgn = line.match(/^(\w+)\s*=\s*(.+?)\s*;\s*$/);
    if (asgn) {
        instructions.push({ type: 'assign', line: i, varName: asgn[1], expr: asgn[2] });
        return i + 1;
    }

    instructions.push({ type: 'noop', line: i });
    return i + 1;
}

/* ── For loop ─────────────────────────────────────────────── */
function compileFor(lines, i) {
    const line = lines[i].trim();

    /* Support: for(type v=init; cond; update) or for(v=init; cond; update) */
    const fm = line.match(/^for\s*\(\s*(.*?);\s*(.*?);\s*(.*?)\s*\)\s*\{?/);
    if (!fm) {
        parseErrors.push(`Line ${i + 1}: Malformed for-loop header`);
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    const [, initPart, condPart, updPart] = fm;

    // Emit init
    const initType = initPart.match(new RegExp(`^(${ALL_TYPES.join('|')})\\s+(\\w+)\\s*=\\s*(.+)$`));
    const initAsgn = initPart.match(/^(\w+)\s*=\s*(.+)$/);
    if (initType) {
        instructions.push({ type: 'declare', line: i, varType: initType[1], varName: initType[2], expr: initType[3] });
    } else if (initAsgn) {
        instructions.push({ type: 'assign', line: i, varName: initAsgn[1], expr: initAsgn[2] });
    }

    // Condition jump
    const condIdx = instructions.length;
    const condExpr = condPart.trim() === '' ? '1' : condPart;
    instructions.push({ type: 'jif0', line: i, expr: condExpr, target: -1 });

    // Body
    const bOpen = findBlockOpen(lines, i);
    const bClose = findMatchingClose(lines, bOpen);
    compileRange(lines, bOpen + 1, bClose - 1);

    // Update
    emitUpdate(updPart, i);

    // Jump back
    instructions.push({ type: 'jump', line: i, target: condIdx });

    // Patch condition exit
    instructions[condIdx].target = instructions.length;
    instructions.push({ type: 'noop', line: bClose });

    return bClose + 1;
}

/* ── While loop ───────────────────────────────────────────── */
function compileWhile(lines, i) {
    const line = lines[i].trim();
    const wm = line.match(/^while\s*\(\s*(.+?)\s*\)\s*\{?/);
    if (!wm) {
        parseErrors.push(`Line ${i + 1}: Malformed while-loop header`);
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    const condPart = wm[1];
    const bOpen = findBlockOpen(lines, i);
    const bClose = findMatchingClose(lines, bOpen);

    const condIdx = instructions.length;
    instructions.push({ type: 'jif0', line: i, expr: condPart, target: -1 });

    compileRange(lines, bOpen + 1, bClose - 1);

    instructions.push({ type: 'jump', line: i, target: condIdx });
    instructions[condIdx].target = instructions.length;
    instructions.push({ type: 'noop', line: bClose });

    return bClose + 1;
}

/* ── Do-While ─────────────────────────────────────────────── */
function compileDo(lines, i) {
    const bOpen = findBlockOpen(lines, i);
    const bClose = findMatchingClose(lines, bOpen);

    const bodyStart = instructions.length;
    compileRange(lines, bOpen + 1, bClose - 1);

    // Find while(...) after closing brace
    let condPart = '0', condLine = bClose;
    for (let j = bClose; j <= Math.min(bClose + 2, lines.length - 1); j++) {
        const cm = lines[j].trim().match(/while\s*\(\s*(.+?)\s*\)/);
        if (cm) { condPart = cm[1]; condLine = j; break; }
    }

    instructions.push({ type: 'jif1', line: condLine, expr: condPart, target: bodyStart });
    instructions.push({ type: 'noop', line: condLine });
    return condLine + 1;
}

/* ── If / else-if / else ──────────────────────────────────── */
function compileIf(lines, i) {
    const line = lines[i].trim();
    const im = line.match(/^if\s*\(\s*(.+?)\s*\)\s*\{?/);
    if (!im) {
        parseErrors.push(`Line ${i + 1}: Malformed if-statement`);
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    const condPart = im[1];
    const bOpen = findBlockOpen(lines, i);
    const bClose = findMatchingClose(lines, bOpen);

    const condIdx = instructions.length;
    instructions.push({ type: 'jif0', line: i, expr: condPart, target: -1 });

    compileRange(lines, bOpen + 1, bClose - 1);

    const next = bClose + 1;
    const nextTxt = (next < lines.length ? lines[next] : '').trim();

    if (nextTxt.startsWith('else')) {
        const elseJump = instructions.length;
        instructions.push({ type: 'jump', line: bClose, target: -1 });
        instructions[condIdx].target = instructions.length;

        if (/^else\s+if/.test(nextTxt)) {
            const after = compileIf(lines, next);
            instructions[elseJump].target = instructions.length;
            return after;
        } else {
            const eOpen = findBlockOpen(lines, next);
            const eClose = findMatchingClose(lines, eOpen);
            compileRange(lines, eOpen + 1, eClose - 1);
            instructions[elseJump].target = instructions.length;
            instructions.push({ type: 'noop', line: eClose });
            return eClose + 1;
        }
    } else {
        instructions[condIdx].target = instructions.length;
        instructions.push({ type: 'noop', line: bClose });
        return bClose + 1;
    }
}

/* ── Emit update expression (for-loop) ───────────────────── */
function emitUpdate(part, line) {
    const post = part.match(/^(\w+)\s*(\+\+|--)$/);
    const pre = part.match(/^(\+\+|--)\s*(\w+)$/);
    const comp = part.match(/^(\w+)\s*(\+=|-=|\*=|\/=)\s*(.+)$/);
    const asgn = part.match(/^(\w+)\s*=\s*(.+)$/);

    if (post) instructions.push({ type: 'incrdecr', line, varName: post[1], op: post[2] });
    else if (pre) instructions.push({ type: 'incrdecr', line, varName: pre[2], op: pre[1] });
    else if (comp) instructions.push({ type: 'compound', line, varName: comp[1], op: comp[2], expr: comp[3] });
    else if (asgn) instructions.push({ type: 'assign', line, varName: asgn[1], expr: asgn[2] });
}

/* ─────────────────── EXECUTION ENGINE ─────────────────── */

function execStep() {
    if (isFinished || ip >= instructions.length) {
        isFinished = true;
        return false;
    }

    const ins = instructions[ip];
    currentLine = ins.line;

    // Clear "changed" flags
    for (const v in memory) memory[v].changed = false;

    try {
        switch (ins.type) {

            case 'halt':
                isFinished = true;
                ip++;
                break;

            case 'noop':
                ip++;
                break;

            case 'declare': {
                const val = evalExpr(ins.expr);
                memory[ins.varName] = { type: ins.varType, value: coerce(val, ins.varType), changed: true };
                ip++;
                break;
            }

            case 'assign': {
                if (!(ins.varName in memory)) throw new Error(`Assignment to undeclared variable '${ins.varName}'`);
                const val = evalExpr(ins.expr);
                memory[ins.varName].value = coerce(val, memory[ins.varName].type);
                memory[ins.varName].changed = true;
                ip++;
                break;
            }

            case 'compound': {
                if (!(ins.varName in memory)) throw new Error(`Undeclared variable '${ins.varName}'`);
                const rhs = evalExpr(ins.expr);
                const cur = memory[ins.varName].value;
                const t = memory[ins.varName].type;
                let nv;
                if (ins.op === '+=') nv = cur + rhs;
                else if (ins.op === '-=') nv = cur - rhs;
                else if (ins.op === '*=') nv = cur * rhs;
                else if (ins.op === '/=') { if (rhs === 0) throw new Error('Division by zero'); nv = cur / rhs; }
                else if (ins.op === '%=') { if (rhs === 0) throw new Error('Modulo by zero'); nv = cur % rhs; }
                else nv = cur;
                memory[ins.varName].value = coerce(nv, t);
                memory[ins.varName].changed = true;
                ip++;
                break;
            }

            case 'incrdecr': {
                if (!(ins.varName in memory)) throw new Error(`Undeclared variable '${ins.varName}'`);
                const t = memory[ins.varName].type;
                const cv = memory[ins.varName].value;
                memory[ins.varName].value = coerce(ins.op === '++' ? cv + 1 : cv - 1, t);
                memory[ins.varName].changed = true;
                ip++;
                break;
            }

            case 'jif0': {
                const cond = evalExpr(ins.expr);
                ip = cond ? ip + 1 : ins.target;
                break;
            }

            case 'jif1': {
                const cond = evalExpr(ins.expr);
                ip = cond ? ins.target : ip + 1;
                break;
            }

            case 'jump':
                ip = ins.target;
                break;

            case 'cout': {
                const parts = ins.expr.split('<<').map(p => p.trim()).filter(Boolean);
                let output = '';
                for (const p of parts) {
                    if (p === 'endl' || p === 'std::endl' || p === '"\\n"' || p === "'\\n'") continue;
                    output += String(evalExpr(p));
                }
                consoleOutput.push(output);
                ip++;
                break;
            }

            default:
                ip++;
        }
    } catch (err) {
        runtimeErrors.push({ line: currentLine, msg: err.message });
        isFinished = true;
        ip = instructions.length;
    }

    render();
    return !isFinished;
}

/* ─────────────────── RENDER ─────────────────── */

function render() {
    renderCode();
    renderVars();
    renderConsole();
    renderErrors();
    renderStatus();
}

function renderCode() {
    const lines = editor.getValue().split('\n');
    const view = document.getElementById('codeView');
    view.innerHTML = '';

    lines.forEach((text, idx) => {
        const div = document.createElement('div');
        div.className = 'c-line';

        const hasErr = runtimeErrors.some(e => e.line === idx);
        if (idx === currentLine && !hasErr) div.classList.add('active');
        if (hasErr) div.classList.add('err-line');

        div.innerHTML = `<span class="ln">${idx + 1}</span><span class="lc">${escHtml(text)}</span>`;
        view.appendChild(div);
    });

    const active = view.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderVars() {
    const view = document.getElementById('varView');
    view.innerHTML = '';

    const keys = Object.keys(memory);

    // Update badge
    const vc = document.getElementById('varCount');
    if (vc) vc.textContent = keys.length + ' var' + (keys.length === 1 ? '' : 's');
    if (!keys.length) {
        view.innerHTML = '<div class="empty-hint">No variables yet</div>';
        return;
    }

    for (const name of keys) {
        const v = memory[name];
        const div = document.createElement('div');
        div.className = 'v-row' + (v.changed ? ' v-changed' : '');

        div.innerHTML = `
          <span class="v-type">${v.type}</span>
          <span class="v-name">${name}</span>
          <span class="v-eq">=</span>
          <span class="v-val">${fmtVal(v.value, v.type)}</span>
        `;
        view.appendChild(div);
    }
}

function renderConsole() {
    const view = document.getElementById('consoleOut');
    if (!view) return;
    view.innerHTML = '';

    if (!consoleOutput.length) {
        view.innerHTML = '<div class="empty-hint">cout output appears here</div>';
        return;
    }
    consoleOutput.forEach(line => {
        const d = document.createElement('div');
        d.className = 'con-line';
        d.textContent = '› ' + line;
        view.appendChild(d);
    });
    view.scrollTop = view.scrollHeight;
}

function renderErrors() {
    const view = document.getElementById('errorView');
    if (!view) return;

    const all = [
        ...parseErrors.map(m => ({ line: -1, msg: m, cls: 'pe' })),
        ...runtimeErrors.map(e => ({ line: e.line, msg: e.msg, cls: 're' }))
    ];

    view.innerHTML = '';
    if (!all.length) {
        view.innerHTML = '<span class="no-err">✓ No errors detected</span>';
        return;
    }
    all.forEach(({ line, msg, cls }) => {
        const d = document.createElement('div');
        d.className = `err-item ${cls}`;
        const loc = line >= 0 ? `Line ${line + 1}: ` : '';
        d.innerHTML = `<i class="fa fa-circle-exclamation"></i> ${loc}${escHtml(msg)}`;
        view.appendChild(d);
    });
}

function renderStatus() {
    const el = document.getElementById('stepInfo');
    if (!el) return;

    const meaningful = instructions.filter(i => !['noop', 'jump'].includes(i.type)).length;

    if (isFinished) {
        el.textContent = runtimeErrors.length ? '⚠ Stopped' : '✓ Done';
        el.className = 'step-badge ' + (runtimeErrors.length ? 'sb-err' : 'sb-done');
    } else {
        el.textContent = `Step ${ip} / ${instructions.length - 1}`;
        el.className = 'step-badge sb-run';
    }
    /* update run-button appearance */
    const runBtn = document.getElementById('runBtn');
    if (runBtn) runBtn.classList.toggle('btn-pause-state', intervalId !== null);
}

function escHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* ─────────────────── CONTROLS ─────────────────── */

function step() {
    if (!isFinished) execStep();
}

function run() {
    if (intervalId !== null) { pause(); return; }
    if (isFinished) return;

    const sv = parseInt(document.getElementById('speedSlider').value);
    const delay = Math.round(2100 - sv);   // higher slider → faster

    intervalId = setInterval(() => {
        if (isFinished || ip >= instructions.length) { pause(); return; }
        execStep();
    }, delay);
    renderStatus();
}

function pause() {
    if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    renderStatus();
}

function reset() {
    pause();
    ip = 0;
    memory = {};
    consoleOutput = [];
    runtimeErrors = [];
    currentLine = -1;
    isFinished = false;

    compile();
    render();
}

/* ─────────────────── INIT ─────────────────── */

function initVisualizer() {
    reset();
    updateUserUI();

    // Re-compile on code change (debounced 800 ms)
    editor.onDidChangeModelContent(() => {
        clearTimeout(window._rcTimer);
        window._rcTimer = setTimeout(() => {
            if (!intervalId) reset();
        }, 800);
    });

    // Enter key in username modal
    document.getElementById('usernameInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') confirmUser();
    });

    // Close modals on backdrop click
    document.getElementById('userModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeUserModal();
    });
    document.getElementById('savesModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeSavesModal();
    });

    // Switch to visualizer tab by default
    switchConsoleTab('visualizer');
}

/* ═══════════════════════════════════════════════════════════
   USER & SAVE SYSTEM  (localStorage-based, keyed by username)
   ═══════════════════════════════════════════════════════════ */

function getCurrentUser() {
    return localStorage.getItem('codeViz:currentUser') || '';
}

function updateUserUI() {
    const user = getCurrentUser();
    const loginBtn = document.getElementById('loginBtn');
    const userChip = document.getElementById('userChip');
    const display = document.getElementById('userNameDisplay');

    if (user) {
        loginBtn && (loginBtn.style.display = 'none');
        userChip && (userChip.style.display = 'flex');
        display && (display.textContent = user);
    } else {
        loginBtn && (loginBtn.style.display = 'flex');
        userChip && (userChip.style.display = 'none');
    }
}

function showUserModal() {
    document.getElementById('userModal').classList.add('open');
    setTimeout(() => document.getElementById('usernameInput').focus(), 80);
}
function closeUserModal() {
    document.getElementById('userModal').classList.remove('open');
}

function confirmUser() {
    const input = document.getElementById('usernameInput');
    const username = input.value.trim();
    if (!username) { input.classList.add('input-shake'); setTimeout(() => input.classList.remove('input-shake'), 400); return; }
    localStorage.setItem('codeViz:currentUser', username);
    input.value = '';
    closeUserModal();
    updateUserUI();
    showToast(`Welcome, ${username}!`, 'success');
}

function signOut() {
    localStorage.removeItem('codeViz:currentUser');
    updateUserUI();
    showToast('Signed out', 'info');
}

/* ── Save ─────────────────────────────────────────────────── */
async function saveCode() {
    const user = getCurrentUser();
    if (!user) { showUserModal(); return; }

    const btn = document.querySelector('.btn-save');
    if (btn) btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i><span>Saving</span>';

    try {
        await convex.mutation("saves:saveCode", {
            user: user,
            code: window.editor.getValue(),
            label: new Date().toLocaleString(),
            timestamp: Date.now()
        });
        showToast('✓ Progress saved to Cloud!', 'success');
    } catch (e) {
        console.error("Save error:", e);
        showToast('Error saving to Cloud', 'error');
    } finally {
        if (btn) btn.innerHTML = '<i class="fa fa-floppy-disk"></i><span>Save</span>';
    }
}

/* ── Load ─────────────────────────────────────────────────── */
let __cloudSavesCache = []; // To easily reference loaded saves by index

async function loadSaves() {
    const user = getCurrentUser();
    if (!user) { showUserModal(); return; }

    const list = document.getElementById('savesList');
    list.innerHTML = `<div class="empty-hint"><i class="fa fa-spinner fa-spin"></i> Loading from Cloud...</div>`;
    document.getElementById('savesModal').classList.add('open');

    try {
        const saves = await convex.query("saves:listSaves", { user });
        __cloudSavesCache = saves;

        if (!saves.length) {
            list.innerHTML = `<div class="empty-hint">No Cloud saves found for <strong>${escHtml(user)}</strong>.<br>Click <em>Save</em> after writing some code!</div>`;
        } else {
            list.innerHTML = saves.map((s, i) => `
              <div class="save-item">
                <div class="save-meta">
                  <i class="fa fa-cloud"></i>
                  <span class="save-label">${escHtml(s.label)}</span>
                </div>
                <pre class="save-preview">${escHtml(s.code.split('\\n').slice(0, 4).join('\\n'))}</pre>
                <button class="ctrl-btn btn-load-item" onclick="loadSave(${i})">
                  <i class="fa fa-folder-open"></i> Load
                </button>
              </div>
            `).join('');
        }
    } catch (e) {
        console.error("Load error:", e);
        list.innerHTML = `<div class="empty-hint" style="color:var(--c-err)">Failed to load saves from Cloud.</div>`;
    }
}

function closeSavesModal() {
    document.getElementById('savesModal').classList.remove('open');
}

function loadSave(index) {
    if (!__cloudSavesCache[index]) return;
    window.editor.setValue(__cloudSavesCache[index].code);
    reset();
    closeSavesModal();
    showToast('Code loaded from Cloud!', 'success');
}

/* ═══════════════════════════════════════════════════════════
   REAL C++ COMPILER  (Wandbox — free, no key, CORS-safe)
   CodeChef-level: real GCC 14, stdin support, execution stats
   ═══════════════════════════════════════════════════════════ */

function toggleStdin() {
    const area = document.getElementById('stdinArea');
    const btn = document.getElementById('stdinToggleBtn');
    const visible = area.style.display !== 'none';
    area.style.display = visible ? 'none' : 'flex';
    btn.classList.toggle('stdin-active', !visible);
    if (!visible) document.getElementById('stdinInput').focus();
}

async function compileAndRun() {
    const btn = document.getElementById('compileBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i><span>Compiling…</span>';

    switchConsoleTab('compiler');
    const out = document.getElementById('compileOut');
    out.innerHTML = '<div class="compile-loading"><i class="fa fa-spinner fa-spin"></i> Sending to GCC 14 (Wandbox)…</div>';

    const stdinVal = (document.getElementById('stdinInput')?.value || '');
    const startTime = performance.now();

    try {
        const res = await fetch('https://wandbox.org/api/compile.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                compiler: 'gcc-head',
                code: editor.getValue(),
                options: 'warning,c++17',
                'compiler-option-raw': '-std=c++17\n-O2',
                stdin: stdinVal
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
        const elapsed = Math.round(performance.now() - startTime);
        renderCompilerOutput(await res.json(), elapsed, stdinVal);
    } catch (e) {
        out.innerHTML = `<div class="err-item re"><i class="fa fa-circle-exclamation"></i>
            Compiler service error: ${escHtml(e.message)}</div>
            <div class="compile-tip">Check your internet connection or try again shortly.</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-hammer"></i><span>Compile & Run</span>';
    }
}

function renderCompilerOutput(data, elapsedMs, stdinUsed) {
    const out = document.getElementById('compileOut');
    const success = String(data.status) === '0';
    out.innerHTML = '';

    // Status banner
    const banner = document.createElement('div');
    banner.className = `compile-status ${success ? 'cs-ok' : 'cs-err'}`;
    banner.innerHTML = success
        ? '<i class="fa fa-circle-check"></i> Compiled & ran successfully (exit 0)'
        : `<i class="fa fa-circle-xmark"></i> Exited with status ${escHtml(String(data.status))}`;
    out.appendChild(banner);

    // Execution stats bar
    if (elapsedMs !== undefined) {
        const statsBar = document.createElement('div');
        statsBar.className = 'compile-stats';
        const rawVer = data.compiler_version ? String(data.compiler_version).split('\n')[0] : 'GCC (head)';
        const gccVer = escHtml(rawVer.replace('gcc version ', ''));
        statsBar.innerHTML =
            '<div class="compile-stat"><i class="fa fa-clock"></i>&nbsp;<span>' + elapsedMs + ' ms</span>&nbsp;round-trip</div>' +
            '<div class="compile-stat"><i class="fa fa-microchip"></i>&nbsp;<span>GCC ' + gccVer + '</span></div>' +
            '<div class="compile-stat"><i class="fa fa-code"></i>&nbsp;<span>C++17 -O2</span></div>';
        out.appendChild(statsBar);
    }

    // Stdin echo
    if (stdinUsed && stdinUsed.trim()) {
        const echoWrap = document.createElement('div');
        const lbl = document.createElement('div');
        lbl.className = 'stdin-echo-label';
        lbl.innerHTML = '<i class="fa fa-keyboard"></i>&nbsp;stdin sent';
        const echoBox = document.createElement('div');
        echoBox.className = 'stdin-echo';
        echoBox.textContent = stdinUsed;
        echoWrap.appendChild(lbl);
        echoWrap.appendChild(echoBox);
        out.appendChild(echoWrap);
    }

    // Compiler messages
    const compMsg = ((data.compiler_error || '') + (data.compiler_output || '')).trim();
    if (compMsg) {
        out.appendChild(makeCompileSection(
            '<i class="fa fa-triangle-exclamation"></i> Compiler Messages',
            compMsg, 'compile-warn'
        ));
    }

    // Program output
    const progOut = ((data.program_output || '') + (data.program_error || '')).trim();
    if (progOut) {
        out.appendChild(makeCompileSection(
            '<i class="fa fa-terminal"></i> Program Output',
            progOut, 'compile-stdout'
        ));
    }

    if (!compMsg && !progOut) {
        out.innerHTML += '<div class="empty-hint">Program ran but produced no output.</div>';
    }
}

function makeCompileSection(titleHTML, text, cls) {
    const sec = document.createElement('div');
    sec.className = 'compile-section';
    const title = document.createElement('div');
    title.className = 'compile-sec-title';
    title.innerHTML = titleHTML;
    const pre = document.createElement('pre');
    pre.className = `compile-pre ${cls}`;
    pre.textContent = text;
    sec.appendChild(title);
    sec.appendChild(pre);
    return sec;
}

/* ═══════════════════════════════════════════════════════════
   CONSOLE TABS
   ═══════════════════════════════════════════════════════════ */

function switchConsoleTab(tab) {
    const vizTab = document.getElementById('tabViz');
    const cmpTab = document.getElementById('tabCompiler');
    const vizOut = document.getElementById('consoleOut');
    const cmpOut = document.getElementById('compileOut');

    const isViz = tab === 'visualizer';
    vizTab && vizTab.classList.toggle('tab-active', isViz);
    cmpTab && cmpTab.classList.toggle('tab-active', !isViz);
    if (vizOut) vizOut.style.display = isViz ? '' : 'none';
    if (cmpOut) cmpOut.style.display = isViz ? 'none' : '';
}

/* ═══════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════ */

function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? 'fa-circle-check' : 'fa-circle-info';
    toast.innerHTML = `<i class="fa ${icon}"></i> ${escHtml(msg)}`;
    container.appendChild(toast);
    requestAnimationFrame(() => { requestAnimationFrame(() => toast.classList.add('toast-show')); });
    setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 350);
    }, 2800);
}

/* ═══════════════════════════════════════════════════════════
   EXPORT TO WINDOW (Since this is now a module)
   ═══════════════════════════════════════════════════════════ */
Object.assign(window, {
    initVisualizer,
    showUserModal,
    closeUserModal,
    confirmUser,
    signOut,
    saveCode,
    loadSaves,
    loadSave,
    closeSavesModal,
    step,
    run,
    pause,
    reset,
    compileAndRun,
    toggleStdin,
    switchConsoleTab
});
