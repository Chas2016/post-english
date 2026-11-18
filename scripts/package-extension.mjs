import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('manifest.json 中的版本号应为 x.y.z。');
}

const files = [
  'LICENSE',
  'manifest.json',
  'background.js',
  'content.css', 'content.js',
  'x-context.js', 'x-learning.css', 'x-learning.js', 'x-learning-ui.js',
  'compose/compose.css', 'compose/compose.html', 'compose/compose.js',
  'options/options.css', 'options/options.html', 'options/options.js',
  'popup/popup.css', 'popup/popup.html', 'popup/popup.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
];

const manifestFiles = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.action.default_icon),
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(({ css, js }) => [...css, ...js]),
  ...manifest.web_accessible_resources.flatMap(({ resources }) => resources)
];

for (const file of manifestFiles) {
  if (!files.includes(file)) throw new Error(`扩展清单引用的文件未列入安装包：${file}`);
}

for (const file of files) {
  if (!lstatSync(path.join(root, file)).isFile()) throw new Error(`安装包仅接受普通文件：${file}`);
}

const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });
const temporary = mkdtempSync(path.join(dist, '.zip-'));
const filename = `post-english-v${version}.zip`;
const archive = path.join(temporary, filename);
try {
  execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: root, stdio: 'inherit' });
  renameSync(archive, path.join(dist, filename));
  console.log(`dist/${filename}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
