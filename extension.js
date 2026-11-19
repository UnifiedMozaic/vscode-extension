// UnifiedMozaic の VSCode 拡張。
// npm の依存は持たない（vscode モジュールは VSCode が実行時に渡す）。コンパイラはこのリポジトリの src/cli.ts を node で呼ぶ。
'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LANG = 'unifiedmozaic';

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.ExtensionContext} */
let extContext;
/** 入口のファイル → そのファイルの検査で診断を出したファイルたち（import 先を含む）。次の検査の前に消すため。 */
const reported = new Map();
/** 入口のファイル → 何回目の検査か。古い検査の結果が後から届いても捨てるため。 */
const generation = new Map();

function config() {
    return vscode.workspace.getConfiguration('unifiedmozaic');
}

function expandHome(p) {
    return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** コンパイラ（src/cli.ts）を探す。設定 → UM_DIR → 開いているフォルダ（とその隣の UnifiedMozaic）→ 拡張の実体の隣の UnifiedMozaic。 */
function findCli() {
    const candidates = [];
    const set = config().get('compilerPath');
    if (set) candidates.push(expandHome(set));
    if (process.env.UM_DIR) candidates.push(process.env.UM_DIR);
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(f.uri.fsPath, path.join(f.uri.fsPath, '..', 'UnifiedMozaic'));
    }
    try {
        // このリポジトリをシンボリックリンクで入れたときは、実体の隣に置いた UnifiedMozaic を見る。
        candidates.push(path.resolve(fs.realpathSync(extContext.extensionPath), '..', 'UnifiedMozaic'));
    } catch {
        // 置き場所が読めなければ飛ばす。
    }
    for (const c of candidates) {
        const cli = c.endsWith('.ts') ? c : path.join(c, 'src', 'cli.ts');
        if (fs.existsSync(cli) && fs.existsSync(path.join(path.dirname(cli), 'checker.ts'))) return cli;
    }
    return undefined;
}

/** node を探す。Dock から起動した VSCode は PATH が短いことがあるので、よくある場所も見る。 */
function findNode() {
    const set = config().get('nodePath');
    if (set) return expandHome(set);
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    for (const d of dirs) {
        const p = path.join(d, 'node');
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
        } catch {
            // 次を見る。
        }
    }
    return 'node';
}

/** コンパイラと node が揃っていなければ知らせて undefined。 */
function tools() {
    const cli = findCli();
    if (!cli) {
        vscode.window.showErrorMessage(
            'UnifiedMozaic のコンパイラ（src/cli.ts）が見つかりません。設定の unifiedmozaic.compilerPath にリポジトリの場所を書いてください。',
            '設定を開く',
        ).then((pick) => {
            if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'unifiedmozaic.compilerPath');
        });
        return undefined;
    }
    return { cli, node: findNode() };
}

function execFile(file, args, opts) {
    return new Promise((resolve) => {
        cp.execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** 診断の位置から、波線を引く範囲（その位置の単語。なければ 1 文字）を作る。 */
function rangeAt(uri, line, col) {
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
        const word = doc.getWordRangeAtPosition(pos);
        if (word) return word;
        const text = doc.lineAt(Math.min(pos.line, doc.lineCount - 1)).text;
        if (pos.character >= text.length) return new vscode.Range(pos.line, Math.max(0, text.length - 1), pos.line, text.length);
    }
    return new vscode.Range(pos, pos.translate(0, 1));
}

/** file を型検査して、診断を出す。結果（JSON）を返す。 */
async function check(file, quiet) {
    const t = tools();
    if (!t) return undefined;
    const gen = (generation.get(file) ?? 0) + 1;
    generation.set(file, gen);
    const dir = path.dirname(file);
    const target = config().get('checkTarget') || 'host';
    const res = await execFile(t.node, [t.cli, 'check', file, '--json', '--target', target], { cwd: dir, timeout: 60_000 });
    if (generation.get(file) !== gen) return undefined;

    let result;
    try {
        result = JSON.parse(res.stdout);
    } catch {
        // コンパイラ自身が落ちた（または node が見つからない）。
        output.appendLine(`[check] ${file}`);
        output.appendLine(res.err ? String(res.err.message) : '');
        output.appendLine(res.stderr);
        if (!quiet) {
            vscode.window.showErrorMessage('UnifiedMozaic: 型検査を実行できませんでした（出力パネルに詳細）。');
            output.show(true);
        }
        return undefined;
    }

    for (const uri of reported.get(file) ?? []) diagnostics.delete(uri);
    const byFile = new Map();
    for (const d of result.errors ?? []) {
        // import される側のファイルには main がないのが普通。no-main は他の検査が全部通った後にだけ出るので、出さなくてよい。
        if (d.code === 'no-main') continue;
        const abs = path.resolve(dir, d.file);
        const uri = vscode.Uri.file(abs);
        const diag = new vscode.Diagnostic(
            rangeAt(uri, d.line, d.col),
            d.hint ? `${d.message}\nhint: ${d.hint}` : d.message,
            vscode.DiagnosticSeverity.Error,
        );
        diag.code = d.code;
        diag.source = 'um';
        if (!byFile.has(abs)) byFile.set(abs, { uri, list: [] });
        byFile.get(abs).list.push(diag);
    }
    const uris = [];
    for (const { uri, list } of byFile.values()) {
        diagnostics.set(uri, list);
        uris.push(uri);
    }
    if (!byFile.has(file)) diagnostics.set(vscode.Uri.file(file), []);
    reported.set(file, uris);
    return result;
}

function isUm(doc) {
    return doc && doc.languageId === LANG && doc.uri.scheme === 'file';
}

/** 今のエディタの .um を保存して、そのパスを返す。 */
async function activeFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isUm(editor.document)) {
        vscode.window.showWarningMessage('UnifiedMozaic: .um のファイルを開いてください。');
        return undefined;
    }
    if (editor.document.isDirty) await editor.document.save();
    return editor.document.uri.fsPath;
}

function outDir() {
    const d = path.join(os.tmpdir(), 'um-vscode');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function shellQuote(s) {
    return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function envPrefix(env) {
    return Object.entries(env)
        .map(([k, v]) => `${k}=${shellQuote(String(v))} `)
        .join('');
}

let terminal;

function runTerminal() {
    if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({ name: 'UnifiedMozaic' });
    }
    return terminal;
}

/** ビルドして、端末で実行する（標準入力もそのまま使える）。 */
async function run(metal) {
    const file = await activeFile();
    if (!file) return;
    const t = tools();
    if (!t) return;
    const result = await check(file, true);
    if (result && !result.ok) {
        if (result.errors.every((d) => d.code === 'no-main')) {
            vscode.window.showErrorMessage('UnifiedMozaic: 実行するには `export function main(): i32 { ... return 0; }` が要ります。');
            return;
        }
        vscode.commands.executeCommand('workbench.actions.view.problems');
        vscode.window.showErrorMessage(`UnifiedMozaic: コンパイルエラーが ${result.errors.length} 件あります。`);
        return;
    }
    const stem = path.basename(file).replace(/\.um$/, '');
    const exe = path.join(outDir(), metal ? `${stem}.metal-bin` : stem);
    const buildEnv = metal ? { UM_METAL: '1' } : {};
    const runEnv = config().get('runEnv') ?? {};
    const args = config().get('runArgs') ?? '';
    const q = shellQuote;
    const cmd = `cd ${q(path.dirname(file))} && ${envPrefix(buildEnv)}${q(t.node)} ${q(t.cli)} build ${q(file)} --target host -o ${q(exe)}`
        + ` && ${envPrefix(runEnv)}${q(exe)}${args ? ' ' + args : ''}`;
    const term = runTerminal();
    term.show(true);
    term.sendText(cmd);
}

/** コンパイラで書き出したテキスト（LLVM IR / MSL）を横に開く。 */
async function showEmitted(kind) {
    const file = await activeFile();
    if (!file) return;
    const t = tools();
    if (!t) return;
    const stem = path.basename(file).replace(/\.um$/, '');
    const dir = path.join(outDir(), 'emit');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, stem);
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(stem + '.')) fs.rmSync(path.join(dir, f), { force: true });
    }
    const args = kind === 'llvm'
        ? [t.cli, 'build', file, '--target', 'host', '--emit-llvm', '-o', base + '.ll']
        : [t.cli, 'build', file, '--target', 'host', '--emit-msl', '-o', base];
    const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `UnifiedMozaic: ${kind === 'llvm' ? 'LLVM IR' : 'MSL'} を書き出しています…` },
        () => execFile(t.node, args, { cwd: path.dirname(file), timeout: 300_000 }),
    );
    if (res.err) {
        await check(file, true);
        output.appendLine(`[${kind}] ${file}`);
        output.appendLine(res.stderr);
        output.show(true);
        vscode.window.showErrorMessage('UnifiedMozaic: 書き出せませんでした（問題パネルと出力パネルに詳細）。');
        return;
    }
    let target;
    if (kind === 'llvm') {
        target = base + '.ll';
    } else {
        const files = fs.readdirSync(dir).filter((f) => f.startsWith(stem + '.') && f.endsWith('.metal'));
        if (files.length === 0) {
            vscode.window.showInformationMessage('UnifiedMozaic: このファイルに kernel 関数はありません。');
            return;
        }
        const pick = files.length === 1 ? files[0] : await vscode.window.showQuickPick(
            files.map((f) => f.slice(stem.length + 1, -'.metal'.length)),
            { placeHolder: 'どの kernel の MSL を開きますか' },
        ).then((k) => k && `${stem}.${k}.metal`);
        if (!pick) return;
        target = path.join(dir, pick);
    }
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

/** 宣言の行から、対応する } の行までを探す（文字列とコメントは大まかに飛ばす）。 */
function blockEnd(doc, startLine) {
    let depth = 0;
    let opened = false;
    let inBlockComment = false;
    for (let l = startLine; l < doc.lineCount; l++) {
        const text = doc.lineAt(l).text;
        let quote = '';
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inBlockComment) {
                if (c === '*' && text[i + 1] === '/') {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }
            if (quote) {
                if (c === '\\') i++;
                else if (c === quote) quote = '';
                continue;
            }
            if (c === '/' && text[i + 1] === '/') break;
            if (c === '/' && text[i + 1] === '*') {
                inBlockComment = true;
                i++;
            } else if (c === '"' || c === "'" || c === '`') {
                quote = c;
            } else if (c === '{') {
                depth++;
                opened = true;
            } else if (c === '}') {
                depth--;
                if (opened && depth === 0) return l;
            } else if (c === ';' && !opened) {
                return l;
            }
        }
    }
    return startLine;
}

const DECLS = [
    { re: /^\s*(?:export\s+)?kernel\s+function\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Event, detail: 'kernel' },
    { re: /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Function, detail: 'function' },
    { re: /^\s*(?:export\s+)?struct\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Struct, detail: 'struct' },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Class, detail: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Interface, detail: 'interface' },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Enum, detail: 'enum' },
    { re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/, kind: vscode.SymbolKind.Constant, detail: 'const' },
];

/** アウトラインとパンくず（関数・kernel・型・トップレベルの定数）。 */
const symbolProvider = {
    provideDocumentSymbols(doc) {
        const symbols = [];
        let skipUntil = -1;
        for (let l = 0; l < doc.lineCount; l++) {
            if (l <= skipUntil) continue;
            const text = doc.lineAt(l).text;
            for (const d of DECLS) {
                const m = d.re.exec(text);
                if (!m) continue;
                const end = blockEnd(doc, l);
                const nameStart = text.indexOf(m[1], m[0].length - m[1].length);
                const sel = new vscode.Range(l, nameStart, l, nameStart + m[1].length);
                const full = new vscode.Range(l, 0, end, doc.lineAt(end).text.length);
                symbols.push(new vscode.DocumentSymbol(m[1], d.detail, d.kind, full, sel));
                // 関数の本体の中はトップレベルではないので飛ばす（class の中のメソッドもここでは出さない）。
                skipUntil = end;
                break;
            }
        }
        return symbols;
    },
};

function activate(context) {
    extContext = context;
    diagnostics = vscode.languages.createDiagnosticCollection('unifiedmozaic');
    output = vscode.window.createOutputChannel('UnifiedMozaic');
    context.subscriptions.push(diagnostics, output);

    const autoCheck = (doc) => {
        if (isUm(doc) && config().get('checkOnSave')) check(doc.uri.fsPath, true);
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(autoCheck),
        vscode.workspace.onDidSaveTextDocument(autoCheck),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (!isUm(doc)) return;
            for (const uri of reported.get(doc.uri.fsPath) ?? []) diagnostics.delete(uri);
            diagnostics.delete(doc.uri);
            reported.delete(doc.uri.fsPath);
        }),
        vscode.commands.registerCommand('unifiedmozaic.check', async () => {
            const file = await activeFile();
            if (!file) return;
            const r = await check(file, false);
            if (r?.ok) vscode.window.setStatusBarMessage('UnifiedMozaic: エラーなし', 3000);
        }),
        vscode.commands.registerCommand('unifiedmozaic.run', () => run(false)),
        vscode.commands.registerCommand('unifiedmozaic.runMetal', () => run(true)),
        vscode.commands.registerCommand('unifiedmozaic.showLLVM', () => showEmitted('llvm')),
        vscode.commands.registerCommand('unifiedmozaic.showMSL', () => showEmitted('msl')),
        vscode.languages.registerDocumentSymbolProvider({ language: LANG }, symbolProvider),
    );
    for (const doc of vscode.workspace.textDocuments) autoCheck(doc);
}

function deactivate() {}

module.exports = { activate, deactivate };
