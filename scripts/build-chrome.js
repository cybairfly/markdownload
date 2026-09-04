#!/usr/bin/env node
// Build a clean, distributable Chrome (Manifest V3) package from ./src.
//
// Copies only the runtime files into ./dist and produces markdownload-mv3.zip.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const zip = path.join(root, 'markdownload-mv3.zip');

const DIRS = ['icons', 'background', 'contentScript', 'offscreen', 'options', 'popup', 'shared'];
const FILES = ['manifest.json'];

function rm(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

rm(dist);
rm(zip);
fs.mkdirSync(dist, { recursive: true });

for (const d of DIRS) fs.cpSync(path.join(src, d), path.join(dist, d), { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(src, f), path.join(dist, f));

// Validate every referenced resource exists before packaging.
function check(p) {
  if (!fs.existsSync(path.join(dist, p))) throw new Error('Missing bundled resource: ' + p);
}
const m = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
Object.values(m.icons || {}).forEach(check);
Object.values((m.action && m.action.default_icon) || {}).forEach(check);
check(m.background.service_worker);
(m.content_scripts || []).forEach(cs => (cs.js || []).forEach(check));
(m.web_accessible_resources || []).forEach(w => (w.resources || []).forEach(check));
check(m.options_ui.page);

execFileSync('zip', ['-qr', zip, '.'], { cwd: dist, stdio: 'inherit' });
console.log('Built', zip);