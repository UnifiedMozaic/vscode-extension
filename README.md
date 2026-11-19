# UnifiedMozaic の VSCode 拡張

[UnifiedMozaic](https://github.com/UnifiedMozaic/UnifiedMozaic) の `.um` のファイルを VSCode で書くための拡張。npm の依存はなく、コンパイラ（UnifiedMozaic のリポジトリの `src/cli.ts`）を node で呼ぶ。

## できること

- **色分け**: 予約語、`kernel function`、`mut` / `own`、数の型（`i32`・`f16`・`u8x16` など）、`Buffer` / `RacyBuffer`、`gpu.*` / `Math.*`、テンプレート文字列の `${...}`、テスト用の `// expect:` / `// stdin:` 行。
- **保存時の型検査**: 開いたときと保存したときに `um check --json` を走らせ、エラーを波線と問題パネルに出す（ヒントつき）。import 先のファイルのエラーはそのファイルに付く。`main` のない部品ファイルの `no-main` は出さない。
- **ビルドして実行**（F5、またはエディタ右上の実行ボタン）: `--target host` でビルドして、端末「UnifiedMozaic」で実行する。標準入力もそのまま使える。実行ファイルは `$TMPDIR/um-vscode/` に置く。
- **Metal でビルドして実行**: `UM_METAL=1` でビルドする（Mac）。
- **LLVM IR を表示** / **kernel の MSL を表示**: 生成したものを横に開く。
- **アウトライン**: 関数・kernel・struct・class・interface・enum・トップレベルの定数。
- **スニペット**: `main`、`kernel`、`dispatch`、`submit`、`struct`、`class`、`for`、`forof`、`match`、`import`。
- **字下げ**: `.um` では常に 4（ファイルの中身からの自動判定はしない）。
- **アイコン**: M の下に U を積んだ白黒の印。`.um` のファイルには明るいテーマで黒、暗いテーマで白の版（`icons/um-light.svg` / `um-dark.svg`）、拡張の一覧には黒い板に白抜きの版（`icons/icon.png`。元は `icons/icon.svg`）。

コマンドはコマンドパレットの「UnifiedMozaic: …」から。

## 入れ方

コンパイラとこのリポジトリを同じフォルダに並べて clone し、このリポジトリを VSCode の拡張のフォルダにリンクして、VSCode を再読み込みする（「Developer: Reload Window」）。

```sh
git clone https://github.com/UnifiedMozaic/UnifiedMozaic.git
git clone https://github.com/UnifiedMozaic/vscode-extension.git
ln -sfn "$PWD/vscode-extension" ~/.vscode/extensions/ofutonmizuki.unifiedmozaic-0.1.0
```

リンクで入れると、拡張の実体の隣にある `UnifiedMozaic` のコンパイラを自動で使う。拡張のファイルを変えたら再読み込みすれば反映される。

## 設定

| 設定 | 既定 | 意味 |
|---|---|---|
| `unifiedmozaic.compilerPath` | 空 | コンパイラの場所（リポジトリのフォルダか `src/cli.ts`）。空なら `UM_DIR`、開いているフォルダ（とその隣の `UnifiedMozaic`）、拡張の置き場所の順に探す |
| `unifiedmozaic.nodePath` | 空 | node（22.18 以上）。空なら PATH と `/opt/homebrew/bin`、`/usr/local/bin` |
| `unifiedmozaic.checkOnSave` | `true` | 開いたとき・保存したときに型検査する |
| `unifiedmozaic.checkTarget` | `host` | 型検査の target（`usize` の幅などが変わる） |
| `unifiedmozaic.runArgs` | 空 | 実行するときの引数 |
| `unifiedmozaic.runEnv` | `{}` | 実行するときの環境変数（例: `{"UM_GPU_STATS": "1", "UM_THREADS": "4"}`） |

UnifiedMozaic で書いた別のプロジェクトのフォルダを開いたときは、隣に置いた `UnifiedMozaic` を自動で見つける。別の場所に置いているなら `compilerPath` か `UM_DIR` を設定する。

## まだないもの

- 保存していない編集中の内容の検査（検査は保存したファイルに対して行う。import の解決がファイルの場所に依るため）。
- 補完・定義へ移動・ホバーでの型の表示（言語サーバーが要る）。

## ライセンス

MIT（[LICENSE-MIT](LICENSE-MIT)）か Apache-2.0（[LICENSE-APACHE](LICENSE-APACHE)）のどちらかを選んで使えます。
