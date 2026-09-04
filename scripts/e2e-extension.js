// MarkDownload E2E test — drives the real extension in a real Chromium
// (headed, under Xvfb) via Playwright.
//
// Run with:  xvfb-run -a node scripts/e2e-extension.js
//
// Verifies (in a real browser, no mocks/polyfills):
//   1. Manifest V3 extension loads and its service worker starts.
//   2. Content script → offscreen conversion pipeline produces Markdown.
//   3. "Download as Markdown" triggers a real download via chrome.downloads
//      (URL.createObjectURL runs in the offscreen document, not the SW).
//   4. Pages without MathJax no longer throw ReferenceError from pageContext.js.
//   5. Options page + chrome.storage work.

const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'src', 'node_modules', 'playwright'));
const http = require('http');
const fs = require('fs');
const os = require('os');

// EARLY DEBUG: prove the script is being executed
console.error('[e2e] starting, cwd=' + process.cwd());

const PATH_ANCHOR = path.join(__dirname, '..', 'src');
const CHROME = process.env.CHROME_BIN || null; // fall back to Playwright's bundled Chromium
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'md-e2e-'));
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dl-'));

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>E2E Test Article</title>
  <meta name="keywords" content="e2e, test, markdown">
</head>
<body>
  <article>
    <h1>E2E Heading</h1>
    <p>This is <strong>bold</strong> text with a <a href="/relative">relative link</a>.</p>
    <p>Second paragraph with <em>emphasis</em>.</p>
    <pre><code class="language-js">const x = 1;</code></pre>
  </article>
</body>
</html>`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✔ ' + name);
  } else {
    failures++;
    console.log('  ✖ ' + name + (extra ? ' — ' + extra : ''));
  }
}

async function waitFor(fn, timeoutMs = 15000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { /* keep polling */ }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('waitFor timed out after ' + timeoutMs + 'ms');
}

async function browserTargets(context) {
  const s = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await s.send('Target.getTargets');
    return (targetInfos || []).map(t => t.type + ' ' + t.url);
  } finally {
    await s.detach();
  }
}

(async () => {
  console.error('[e2e] in main IIFE, CHROME=' + (CHROME || '(playwright chromium)'));
  if (!CHROME) { console.log('Using Playwright bundled Chromium'); }
  console.log('Browser:', CHROME);

  // Small local server for the test article page.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE_HTML);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const TEST_URL = 'http://127.0.0.1:' + server.address().port + '/';
  console.log('Test page:', TEST_URL);

  const launchOpts = {
    headless: false,
    // Playwright adds `--disable-extensions` by default, which would override
    // our `--load-extension`. Ignore that default so the unpacked extension loads.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--load-extension=' + PATH_ANCHOR,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  if (CHROME) launchOpts.executablePath = CHROME;
  const context = await chromium.launchPersistentContext(PROFILE, launchOpts);

  // Allow downloads to a temp dir (browser-level CDP).
  try {
    const bsession = await context.browser().newBrowserCDPSession();
    await bsession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOADS,
      eventsEnabled: true
    });
  } catch (e) {
    console.log('  (note: could not set download behavior via CDP: ' + e.message + ')');
  }

  // 1) Service worker starts.
  let sw = null;
  const swDeadline = Date.now() + 20000;
  while (Date.now() < swDeadline) {
    if (context.serviceWorkers().length) { sw = context.serviceWorkers()[0]; break; }
    if (Date.now() % 4000 < 200) {
      // debug: dump all targets once every ~4s
      try {
        const ts = await browserTargets(context);
        console.log('  [dbg] targets:', ts.join(' | '));
      } catch (e) { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!sw) {
    console.error('  ✖ service worker never started');
    await context.close();
    process.exit(2);
  }
  console.log('Service worker:', sw.url());

  const mv = await sw.evaluate(() => chrome.runtime.getManifest().manifest_version);
  check('manifest_version === 3', mv === 3, 'got ' + mv);

  const hasMenus = await sw.evaluate(() => typeof chrome.contextMenus !== 'undefined');
  check('contextMenus API available in SW', hasMenus === true);

  // 2) Open the test article and run the clip pipeline.
  const page = await context.newPage();
  await page.goto(TEST_URL);
  await page.waitForLoadState('domcontentloaded');

  const clipResult = await sw.evaluate(async (testUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:'));
    if (!tab) return { error: 'no test tab found' };
    const payload = await chrome.tabs.sendMessage(tab.id, { type: 'get-payload' });
    if (!payload || !payload.dom) return { error: 'content script payload missing' };
    const r = await offscreen({ type: 'clip', dom: payload.dom, selection: payload.selection, clipSelection: false });
    return { ok: !!r.ok, markdown: r.markdown || '', title: (r.article && r.article.title) || '', mdClipsFolder: r.mdClipsFolder };
  }, TEST_URL);

  check('clip pipeline ok', clipResult.ok && !clipResult.error, JSON.stringify(clipResult));
  check('markdown has heading', /E2E Heading/.test(clipResult.markdown || ''), clipResult.markdown);
  check('markdown has bold', /\*\*bold\*\*/.test(clipResult.markdown || ''));
  check('relative link absolutized', /\[relative link\]\(http:\/\/127\.0\.0\.1:\d+\/relative\)/.test(clipResult.markdown || ''));
  check('mdClipsFolder returned', typeof clipResult.mdClipsFolder === 'string');

  // 2b) Route format-mdclips directly — this is the exact path that previously
  //     threw "Cannot read properties of undefined (reading 'sync')" inside
  //     the offscreen document.
  const fmtResult = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:'));
    const article = await getArticleFromContent(tab.id, false);
    const options = await getOptions();
    return await offscreen({ type: 'format-mdclips', article, options });
  });
  check('format-mdclips routes without storage error', fmtResult.ok === true, JSON.stringify(fmtResult));
  check('routed mdClipsFolder is a string', typeof fmtResult.mdClipsFolder === 'string');

  // 3) Real download via downloads API (through the offscreen document).
  const downloadResult = await sw.evaluate(async ({ md, title }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:'));
    try {
      await downloadMarkdown(md, title, tab.id, {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }, { md: clipResult.markdown, title: 'E2E-Test-Article' });

  check('downloadMarkdown did not throw', downloadResult.ok === true, JSON.stringify(downloadResult));

  let lastList = [];
  let found = null;
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      lastList = await sw.evaluate(() => chrome.downloads.search({}));
      found = lastList.find(d => d.filename && d.filename.endsWith('E2E-Test-Article.md')) || null;
      if (found) break;
    } catch (e) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!found && lastList.length === 0) {
    // No downloads recorded at all — probe whether downloads even got created.
    const probe = await sw.evaluate(async () => {
      try {
        const { blobUrl } = await offscreen({ type: 'create-blob-url', markdown: '# probe' });
        const id = await chrome.downloads.download({ url: blobUrl, filename: 'probe.md', saveAs: false });
        await new Promise(r => setTimeout(r, 2000));
        const list = await chrome.downloads.search({ id });
        return { id, list, err: null };
      } catch (e) { return { err: String(e && e.message || e) }; }
    });
    console.log('  (probe direct download: ' + JSON.stringify(probe).slice(0, 500) + ')');
  } else if (!found) {
    console.log('  (downloads recorded but none matched: ' + JSON.stringify(lastList.map(d => ({ f: d.filename, s: d.state, e: d.error }))).slice(0, 600) + ')');
  }
  // Playwright's CDP download handling renames files to UUIDs, so we match
  // on the blob: source URL + .md extension + completed state instead.
  found = lastList.find(d => d.state === 'complete' && d.mime && d.mime.includes('markdown')
    && d.url && d.url.startsWith('blob:'))
    || lastList.find(d => d.state === 'complete' && d.filename.endsWith('.md')) || null;
  check('a .md file download was recorded', !!found, found && (found.filename + ' state=' + found.state + ' url=' + found.url.slice(0, 40)));
// 4) MathJax guard: the test page has no MathJax; pageContext.js must not throw.
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(String(err)));
  page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text()); });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 1500));
  const mathJaxErrors = jsErrors.filter(e => /MathJax/.test(e));
  check('no ReferenceError for MathJax on non-MathJax page', mathJaxErrors.length === 0, jsErrors.join(' | ').slice(0, 300));

  // 5) Options page loads and chrome.storage works.
  const optionsUrl = sw.url().replace(/\/background\/background\.js$/, '') + '/options/options.html';
  const optPage = await context.newPage();
  await optPage.goto(optionsUrl).catch(e => console.log('  (options nav: ' + e.message + ')'));
  await new Promise(r => setTimeout(r, 1200));
  const optionsLoaded = await optPage.evaluate(() => document.body.innerText.includes('Import'));
  check('options page loads without error', optionsLoaded === true);

  const storageOk = await sw.evaluate(async () => {
    await chrome.storage.sync.set({ e2eProbe: 42 });
    const got = await chrome.storage.sync.get('e2eProbe');
    return got && got.e2eProbe === 42;
  });
  check('chrome.storage works', storageOk === true);

  // 6) clipTab - the exact code path the popup now uses: SW resolves the tab,
  //    reads the payload (with injection fallback), clips, and broadcasts.
  const clipTabResult = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:'));
    try {
      const r = await clipTab({ tabId: tab.id });
      return { ok: !!r.ok, selection: r.selection };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
  check('clipTab (popup path) works', clipTabResult.ok === true, JSON.stringify(clipTabResult));

  // 7) Injection fallback: load a manifest WITHOUT content_scripts and confirm
  //    the SW injects the content script via chrome.scripting and still clips.
  async function phase2() {
    console.log('\nPhase 2: content-script injection fallback (manifest without content_scripts)');
    const variantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-noCS-'));
    const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md-e2e2-'));
    try {
      // Copy runtime files only (skip node_modules/tests).
      for (const d of ['icons', 'background', 'contentScript', 'offscreen', 'options', 'popup', 'shared']) {
        fs.cpSync(path.join(PATH_ANCHOR, d), path.join(variantDir, d), { recursive: true });
      }
      fs.copyFileSync(path.join(PATH_ANCHOR, 'manifest.json'), path.join(variantDir, 'manifest.json'));
      const mPath = path.join(variantDir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      delete m.content_scripts; // force the injection-fallback path
      fs.writeFileSync(mPath, JSON.stringify(m, null, 2));

      const ctx2 = await chromium.launchPersistentContext(profile2, {
        headless: false,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
          '--load-extension=' + variantDir,
          '--no-first-run', '--no-default-browser-check'
        ]
      });
      try {
        const sw2 = await waitFor(() => ctx2.serviceWorkers()[0]);
        const page2 = await ctx2.newPage();
        await page2.goto(TEST_URL);
        await page2.waitForLoadState('domcontentloaded');
        const r = await sw2.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:'));
          return await clipTab({ tabId: tab.id });
        });
        check('content script injected on demand (no manifest content_scripts)', r && r.ok === true, JSON.stringify(r));
      } finally {
        await ctx2.close();
      }
    } finally {
      fs.rmSync(variantDir, { recursive: true, force: true });
      fs.rmSync(profile2, { recursive: true, force: true });
    }
  }

  await phase2();

  await context.close();

  console.log('\n' + (failures === 0 ? 'ALL E2E CHECKS PASSED ✅' : failures + ' E2E CHECK(S) FAILED ❌'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('E2E framework error:', e);
  try { process.exit(2); } catch (_) {}
});