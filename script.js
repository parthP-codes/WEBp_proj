/* ============================================================
   CODE VISUALIZER PRO — ENHANCED ENGINE v2.0
   Supports: int, float, double, bool, char
             for / while / if-else
             cout, compound assignments, ++/--
   Detects:  undefined vars, div-by-zero, undeclared assign
   ============================================================ */

let instructions = [];     // compiled instruction tape
let ip            = 0;     // instruction pointer
let memory        = {};    // { name: { type, value, changed } }
let consoleOutput = [];
let runtimeErrors = [];
let parseErrors   = [];
let currentLine   = -1;
let intervalId    = null;
let isFinished    = false;

/* ─────────────────── TYPE UTILITIES ─────────────────── */

const NUMERIC_TYPES = ['int','long','short','unsigned'];
const FLOAT_TYPES   = ['float','double'];
const ALL_TYPES     = [...NUMERIC_TYPES, ...FLOAT_TYPES, 'bool','char'];

function defaultFor(type) {
    if (type === 'bool') return 'false';
    if (type === 'char') return "'\\0'";
    return '0';
}

function coerce(val, type) {
    if (val === undefined || val === null) return 0;
    if (NUMERIC_TYPES.includes(type)) return Math.trunc(Number(val));
    if (FLOAT_TYPES.includes(type))   return parseFloat(Number(val).toPrecision(7));
    if (type === 'bool')  return Boolean(val);
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
    const safe = new Set(['true','false','null','undefined','NaN','Infinity','endl','Math']);
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
    parseErrors   = [];

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
    const raw  = lines[i] || '';
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
    if (/^for\s*\(/.test(line))   return compileFor(lines, i, max);
    if (/^while\s*\(/.test(line)) return compileWhile(lines, i, max);
    if (/^if\s*\(/.test(line))    return compileIf(lines, i, max);
    if (/^do\s*\{?/.test(line))   return compileDo(lines, i, max);

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
    const pre  = line.match(/^(\+\+|--)\s*(\w+)\s*;\s*$/);
    if (pre)  { instructions.push({ type: 'incrdecr', line: i, varName: pre[2],  op: pre[1]  }); return i + 1; }

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
    const fm = line.match(/^for\s*\(\s*(.+?);\s*(.+?);\s*(.+?)\s*\)\s*\{?/);
    if (!fm) {
        parseErrors.push(`Line ${i+1}: Malformed for-loop header`);
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
    instructions.push({ type: 'jif0', line: i, expr: condPart, target: -1 });

    // Body
    const bOpen  = findBlockOpen(lines, i);
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
        parseErrors.push(`Line ${i+1}: Malformed while-loop header`);
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    const condPart = wm[1];
    const bOpen    = findBlockOpen(lines, i);
    const bClose   = findMatchingClose(lines, bOpen);

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
    const bOpen  = findBlockOpen(lines, i);
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
        parseErrors.push(`Line ${i+1}: Malformed if-statement`);
        instructions.push({ type: 'noop', line: i });
        return i + 1;
    }

    const condPart = im[1];
    const bOpen    = findBlockOpen(lines, i);
    const bClose   = findMatchingClose(lines, bOpen);

    const condIdx = instructions.length;
    instructions.push({ type: 'jif0', line: i, expr: condPart, target: -1 });

    compileRange(lines, bOpen + 1, bClose - 1);

    const next    = bClose + 1;
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
            const eOpen  = findBlockOpen(lines, next);
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
    const pre  = part.match(/^(\+\+|--)\s*(\w+)$/);
    const comp = part.match(/^(\w+)\s*(\+=|-=|\*=|\/=)\s*(.+)$/);
    const asgn = part.match(/^(\w+)\s*=\s*(.+)$/);

    if      (post) instructions.push({ type: 'incrdecr', line, varName: post[1], op: post[2] });
    else if (pre)  instructions.push({ type: 'incrdecr', line, varName: pre[2],  op: pre[1]  });
    else if (comp) instructions.push({ type: 'compound', line, varName: comp[1], op: comp[2], expr: comp[3] });
    else if (asgn) instructions.push({ type: 'assign',   line, varName: asgn[1], expr: asgn[2] });
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
                memory[ins.varName].value   = coerce(val, memory[ins.varName].type);
                memory[ins.varName].changed = true;
                ip++;
                break;
            }

            case 'compound': {
                if (!(ins.varName in memory)) throw new Error(`Undeclared variable '${ins.varName}'`);
                const rhs = evalExpr(ins.expr);
                const cur = memory[ins.varName].value;
                const t   = memory[ins.varName].type;
                let nv;
                if      (ins.op === '+=') nv = cur + rhs;
                else if (ins.op === '-=') nv = cur - rhs;
                else if (ins.op === '*=') nv = cur * rhs;
                else if (ins.op === '/=') { if (rhs === 0) throw new Error('Division by zero'); nv = cur / rhs; }
                else if (ins.op === '%=') { if (rhs === 0) throw new Error('Modulo by zero');    nv = cur % rhs; }
                else nv = cur;
                memory[ins.varName].value   = coerce(nv, t);
                memory[ins.varName].changed = true;
                ip++;
                break;
            }

            case 'incrdecr': {
                if (!(ins.varName in memory)) throw new Error(`Undeclared variable '${ins.varName}'`);
                const t  = memory[ins.varName].type;
                const cv = memory[ins.varName].value;
                memory[ins.varName].value   = coerce(ins.op === '++' ? cv + 1 : cv - 1, t);
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
                const parts  = ins.expr.split('<<').map(p => p.trim()).filter(Boolean);
                let   output = '';
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
    const view  = document.getElementById('codeView');
    view.innerHTML = '';

    lines.forEach((text, idx) => {
        const div = document.createElement('div');
        div.className = 'c-line';

        const hasErr = runtimeErrors.some(e => e.line === idx);
        if (idx === currentLine && !hasErr) div.classList.add('active');
        if (hasErr)                         div.classList.add('err-line');

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
        const v   = memory[name];
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
        ...parseErrors.map(m => ({ line: -1, msg: m,     cls: 'pe' })),
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

    const meaningful = instructions.filter(i => !['noop','jump'].includes(i.type)).length;

    if (isFinished) {
        el.textContent  = runtimeErrors.length ? '⚠ Stopped' : '✓ Done';
        el.className    = 'step-badge ' + (runtimeErrors.length ? 'sb-err' : 'sb-done');
    } else {
        el.textContent  = `Step ${ip} / ${instructions.length - 1}`;
        el.className    = 'step-badge sb-run';
    }
    /* update run-button appearance */
    const runBtn = document.getElementById('runBtn');
    if (runBtn) runBtn.classList.toggle('btn-pause-state', intervalId !== null);
}

function escHtml(str) {
    return str
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;');
}

/* ─────────────────── CONTROLS ─────────────────── */

function step() {
    if (!isFinished) execStep();
}

function run() {
    if (intervalId !== null) { pause(); return; }
    if (isFinished) return;

    const sv    = parseInt(document.getElementById('speedSlider').value);
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
    ip            = 0;
    memory        = {};
    consoleOutput = [];
    runtimeErrors = [];
    currentLine   = -1;
    isFinished    = false;

    compile();
    render();
}

/* ─────────────────── INIT ─────────────────── */

function initVisualizer() {
    reset();

    // Re-compile on code change (debounced 800 ms)
    editor.onDidChangeModelContent(() => {
        clearTimeout(window._rcTimer);
        window._rcTimer = setTimeout(() => {
            if (!intervalId) reset();
        }, 800);
    });
}
