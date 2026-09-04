// ---------------------------------------------------------------------------
// MarkDownload - Manifest V3 service worker
//
// A MV3 service worker has no DOM and cannot run Mozilla Readability, Turndown
// or other DOM-dependent logic. That work now happens inside the offscreen
// document (see ../offscreen/offscreen.js). This file is a thin event router:
//   - creates/updates the context menus
//   - handles context menu clicks, keyboard commands, and popup messages
//   - reads the page DOM through the content script (tabs.sendMessage)
//   - routes conversion work to the offscreen document
//   - triggers downloads via the downloads API
// ---------------------------------------------------------------------------

importScripts(
  '../shared/default-options.js',
  '../shared/context-menus.js',
  '../shared/filename.js'
);

// log some info
try {
  chrome.runtime.getPlatformInfo().then(async platformInfo => {
    console.info(platformInfo);
  });
} catch (e) {
  // non-fatal
}

// create context menus
createMenus();

// ---------------------------------------------------------------------------
// Offscreen document helpers
// ---------------------------------------------------------------------------

let hasOffscreenDocument = false;

async function getOffscreenDocument() {
  if (hasOffscreenDocument) return;
  try {
    await chrome.offscreen.createDocument({
      url: '/offscreen/offscreen.html',
      reasons: ['DOM_SCRAPING', 'BLOBS'],
      justification: 'Convert the page DOM to Markdown and create blob URLs for downloads.'
    });
  } catch (e) {
    // The document may already exist (e.g. after the service worker restarted).
    if (!/already|exists|single offscreen/i.test(String((e && e.message) || e))) {
      throw e;
    }
  }
  hasOffscreenDocument = true;
}

// Send a message to the offscreen document and await its response.
async function offscreen(message) {
  await getOffscreenDocument();
  let response;
  try {
    response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  } catch (e) {
    // The offscreen document may have been torn down between calls; retry once.
    hasOffscreenDocument = false;
    await getOffscreenDocument();
    response = await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
  }
  if (!response || response.ok !== true) {
    throw new Error((response && response.error) || 'offscreen operation failed');
  }
  return response;
}

// ---------------------------------------------------------------------------
// Content script helpers
// ---------------------------------------------------------------------------

// Get the { selection, dom } payload from the (usually already-injected)
// content script.
async function getPayloadFromTab(tabId) {
  try {
    const payload = await chrome.tabs.sendMessage(tabId, { type: 'get-payload' });
    if (payload && payload.dom) return payload;
  } catch (e) {
    // fall through and try injecting the content script manually
  }

  // The content script may not have been injected yet (e.g. the tab survived
  // an extension update/install). Inject it, then ask again.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript/contentScript.js']
    });
    const payload = await chrome.tabs.sendMessage(tabId, { type: 'get-payload' });
    if (payload && payload.dom) return payload;
  } catch (e) {
    console.error('Failed to read page content: ' + e);
  }

  throw new Error(
    'MarkDownload cannot read this page. If you just installed or reloaded the ' +
    'extension, reload this tab (F5) and try again. Restricted pages ' +
    '(chrome://, the Chrome Web Store, PDFs, etc.) cannot be clipped.'
  );
}

// Copy text to the page clipboard via the (isolated-world) content script.
async function copyToClipboardInTab(tabId, text) {
  await chrome.tabs.sendMessage(tabId, { type: 'copy-to-clipboard', text: text });
}

// replicate the old getArticleFromContent behaviour using offscreen parsing
async function getArticleFromContent(tabId, selection = false) {
  const payload = await getPayloadFromTab(tabId);

  const response = await offscreen({ type: 'get-article', dom: payload.dom });
  const article = response.article;

  // if we're to grab the selection, and we've selected something,
  // replace the article content with the selection
  if (selection && payload.selection) {
    article.content = payload.selection;
  }

  return article;
}
// ---------------------------------------------------------------------------
// Downloads
//
// chrome.downloads.download runs here in the service worker. The blob URL it
// needs is created in the offscreen document (service workers have no
// URL.createObjectURL); we ask the offscreen document to create and later
// revoke the blob URLs.
// ---------------------------------------------------------------------------

function base64EncodeUnicode(str) {
  // Firstly, escape the string using encodeURIComponent to get the UTF-8
  // encoding of the characters, secondly convert the percent encodings into
  // raw bytes, and add it to btoa() function.
  const utf8Bytes = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, p1) {
    return String.fromCharCode('0x' + p1);
  });
  return btoa(utf8Bytes);
}

// Ask the offscreen document to release a blob URL once a download completes.
function revokeBlobUrlWhenDone(id, url) {
  if (!url || !url.startsWith('blob:')) return;
  const listener = async (delta) => {
    if (delta.id === id && delta.state && delta.state.current == "complete") {
      chrome.downloads.onChanged.removeListener(listener);
      try {
        await offscreen({ type: 'revoke-blob-url', url: url });
      } catch (e) { /* offscreen may be gone; blob URLs are released on restart anyway */ }
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

async function downloadMarkdown(markdown, title, tabId, imageList = {}, mdClipsFolder = '') {
  // get the options
  const options = await getOptions();

  // download via the downloads API - the blob URL is created in the offscreen
  // document (URL.createObjectURL is not available in a service worker).
  if (options.downloadMode == 'downloadsApi') {
    try {
      const { blobUrl } = await offscreen({ type: 'create-blob-url', markdown });

      if (mdClipsFolder && !mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
      // start the download of the markdown file
      const id = await chrome.downloads.download({
        url: blobUrl,
        filename: mdClipsFolder + title + ".md",
        saveAs: options.saveAs
      });
      revokeBlobUrlWhenDone(id, blobUrl);

      // download images (if enabled)
      if (options.downloadImages) {
        // get the relative path of the markdown file (if any) for image path
        let destPath = mdClipsFolder + title.substring(0, title.lastIndexOf('/'));
        if (destPath && !destPath.endsWith('/')) destPath += '/';
        Object.entries(imageList).forEach(async ([src, filename]) => {
          try {
            const imgId = await chrome.downloads.download({
              url: src,
              filename: destPath ? destPath + filename : filename,
              saveAs: false
            });
            revokeBlobUrlWhenDone(imgId, src);
          } catch (err) {
            console.error("Failed to download image " + src, err);
          }
        });
      }
    }
    catch (err) {
      console.error("Download failed", err);
    }
  }
  // download via the content link method (needs the content script)
  else {
    try {
      const filename = mdClipsFolder + generateValidFileName(title, options.disallowedChars) + ".md";
      await chrome.tabs.sendMessage(tabId, {
        type: 'download-markdown',
        filename: filename,
        data: base64EncodeUnicode(markdown)
      });
    }
    catch (error) {
      // This could happen if the extension is not allowed to run code in
      // the page, for example if the tab is a privileged page.
      console.error("Failed to execute script: " + error);
    }
  }
}
// ---------------------------------------------------------------------------
// Message handling (from popup and content script)
// ---------------------------------------------------------------------------

// Handles a "clip" message from the popup. Converts the DOM in the offscreen
// document and broadcasts the result back to the popup (and any other UIs).
// Options are fetched here (the service worker has chrome.storage) and passed
// to the offscreen document, which cannot use chrome.storage itself.
async function handleClip(message) {
  const options = await getOptions();
  const response = await offscreen({
    type: 'clip',
    dom: message.dom,
    selection: message.selection,
    clipSelection: message.clipSelection,
    options
  });
  // display the data in the popup
  try {
    await chrome.runtime.sendMessage({
      type: "display.md",
      markdown: response.markdown,
      article: response.article,
      imageList: response.imageList,
      mdClipsFolder: response.mdClipsFolder
    });
  } catch (e) {
    // popup closed before we could reply - this is fine
  }
  return response;
}

// Handles a "clip-tab" message from the popup: resolves the target tab,
// reads the page payload (injecting the content script if it is missing -
// e.g. a tab that outlived an extension install/reload), then clips.
// This centralises the injection fallback the MV2 popup used to do itself.
async function clipTab(message) {
  let tabId = message.tabId;
  if (tabId == null) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab found.');
    tabId = tab.id;
  }
  const payload = await getPayloadFromTab(tabId);
  if (!payload || !payload.dom) {
    throw new Error('Could not read the page content.');
  }
  const options = await getOptions();
  await handleClip({
    dom: payload.dom,
    selection: payload.selection,
    clipSelection: message.clipSelection != null ? message.clipSelection : options.clipSelection
  });
  return { ok: true, selection: payload.selection || '' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages meant for the offscreen document are not handled here.
  if (!message || message.target === 'offscreen') return;

  // message for initial clipping of the dom (from the popup)
  if (message.type == "clip") {
    handleClip(message)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        console.error("Failed to clip: " + error);
        sendResponse({ ok: false, error: String(error && error.message || error) });
      });
    return true; // keep the channel open until we reply
  }

  // message asking the service worker to clip a tab (from the popup). The SW
  // resolves the tab, injects the content script if needed, and clips.
  else if (message.type == "clip-tab") {
    clipTab(message)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error("Failed to clip tab: " + error);
        sendResponse({ ok: false, error: String(error && error.message || error) });
      });
    return true; // keep the channel open until we reply
  }

  // message for triggering a download (from the popup)
  else if (message.type == "download") {
    downloadMarkdown(message.markdown, message.title, message.tab.id, message.imageList, message.mdClipsFolder);
  }
});
// this function toggles the specified option
async function toggleSetting(setting, options = null) {
  // if there's no options object passed in, we need to go get one
  if (options == null) {
    await toggleSetting(setting, await getOptions());
  }
  else {
    // toggle the option and save back to storage
    options[setting] = !options[setting];
    await chrome.storage.sync.set(options);
    if (setting == "includeTemplate") {
      chrome.contextMenus.update("toggle-includeTemplate", {
        checked: options.includeTemplate
      }).catch(() => {});
      try {
        chrome.contextMenus.update("tabtoggle-includeTemplate", {
          checked: options.includeTemplate
        }).catch(() => {});
      } catch { }
    }

    if (setting == "downloadImages") {
      chrome.contextMenus.update("toggle-downloadImages", {
        checked: options.downloadImages
      }).catch(() => {});
      try {
        chrome.contextMenus.update("tabtoggle-downloadImages", {
          checked: options.downloadImages
        }).catch(() => {});
      } catch { }
    }
  }
}

// helper to get the active tab in the current window (used by commands)
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// ---------------------------------------------------------------------------
// Keyboard commands
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async function (command) {
  const tab = await getActiveTab();
  if (!tab) {
    console.warn("No active tab found for command: " + command);
    return;
  }

  try {
    if (command == "download_tab_as_markdown") {
      const info = { menuItemId: "download-markdown-all" };
      await downloadMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_as_markdown") {
      const info = { menuItemId: "copy-markdown-all" };
      await copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_selection_as_markdown") {
      const info = { menuItemId: "copy-markdown-selection" };
      await copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_as_markdown_link") {
      await copyTabAsMarkdownLink(tab);
    }
    else if (command == "copy_selected_tab_as_markdown_link") {
      await copySelectedTabAsMarkdownLink(tab);
    }
    else if (command == "copy_selection_to_obsidian") {
      const info = { menuItemId: "copy-markdown-obsidian" };
      await copyMarkdownFromContext(info, tab);
    }
    else if (command == "copy_tab_to_obsidian") {
      const info = { menuItemId: "copy-markdown-obsall" };
      await copyMarkdownFromContext(info, tab);
    }
  } catch (error) {
    console.error("Failed to run command: " + error);
  }
});

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener(function (info, tab) {
  (async () => {
    // one of the copy to clipboard commands
    if (info.menuItemId.startsWith("copy-markdown")) {
      await copyMarkdownFromContext(info, tab);
    }
    // one of the "download all tabs" commands
    else if (info.menuItemId == "download-markdown-alltabs" ||
             info.menuItemId == "tab-download-markdown-alltabs") {
      await downloadMarkdownForAllTabs(info);
    }
    // one of the download commands
    else if (info.menuItemId.startsWith("download-markdown")) {
      await downloadMarkdownFromContext(info, tab);
    }
    // copy tab as markdown link
    else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-all")) {
      await copyTabAsMarkdownLinkAll(tab);
    }
    // copy only selected tab as markdown link
    else if (info.menuItemId.startsWith("copy-tab-as-markdown-link-selected")) {
      await copySelectedTabAsMarkdownLink(tab);
    }
    else if (info.menuItemId.startsWith("copy-tab-as-markdown-link")) {
      await copyTabAsMarkdownLink(tab);
    }
    // a settings toggle command
    else if (info.menuItemId.startsWith("toggle-") || info.menuItemId.startsWith("tabtoggle-")) {
      await toggleSetting(info.menuItemId.split('-')[1]);
    }
  })().catch(error => {
    console.error("Context menu action failed: " + error);
  });
});
// ---------------------------------------------------------------------------
// Shared helpers that delegate DOM/formatting work to the offscreen document.
// Options are always fetched here (service worker has chrome.storage) and
// passed along, because offscreen documents cannot use chrome.storage.
// ---------------------------------------------------------------------------

// function to apply the title template (delegated to offscreen for formatting)
async function formatTitle(article) {
  const options = await getOptions();
  const response = await offscreen({ type: 'format-title', article, options });
  return response.title;
}

async function formatMdClipsFolder(article) {
  const options = await getOptions();
  const response = await offscreen({ type: 'format-mdclips', article, options });
  return response.mdClipsFolder;
}

async function formatObsidianFolder(article) {
  const options = await getOptions();
  const response = await offscreen({ type: 'format-obsidian', article, options });
  return response.obsidianFolder;
}

// function to convert an article info object into markdown
async function convertArticleToMarkdown(article, downloadImages = null) {
  const options = await getOptions();
  const response = await offscreen({
    type: 'convert-article',
    article,
    downloadImages,
    options
  });
  return { markdown: response.markdown, imageList: response.imageList };
}

// function to download markdown, triggered by context menu
async function downloadMarkdownFromContext(info, tab) {
  const article = await getArticleFromContent(tab.id, info.menuItemId == "download-markdown-selection");
  const title = await formatTitle(article);
  const { markdown, imageList } = await convertArticleToMarkdown(article);
  // format the mdClipsFolder
  const mdClipsFolder = await formatMdClipsFolder(article);
  await downloadMarkdown(markdown, title, tab.id, imageList, mdClipsFolder);
}

// function to copy a tab url as a markdown link
async function copyTabAsMarkdownLink(tab) {
  try {
    const article = await getArticleFromContent(tab.id);
    const title = await formatTitle(article);
    await copyToClipboardInTab(tab.id, `[${title}](${article.baseURI})`);
  }
  catch (error) {
    console.error("Failed to copy as markdown link: " + error);
  }
}

// function to copy all tabs as markdown links
async function copyTabAsMarkdownLinkAll(tab) {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = '';
    const tabs = await chrome.tabs.query({
      currentWindow: true
    });

    const links = [];
    for (const currentTab of tabs) {
      const article = await getArticleFromContent(currentTab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`
      links.push(link)
    }

    const markdown = links.join(`\n`)
    await copyToClipboardInTab(tab.id, markdown);
  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy as markdown link: " + error);
  }
}

// function to copy only selected tabs as markdown links
async function copySelectedTabAsMarkdownLink(tab) {
  try {
    const options = await getOptions();
    options.frontmatter = options.backmatter = '';
    const tabs = await chrome.tabs.query({
      currentWindow: true,
      highlighted: true
    });

    const links = [];
    for (const currentTab of tabs) {
      const article = await getArticleFromContent(currentTab.id);
      const title = await formatTitle(article);
      const link = `${options.bulletListMarker} [${title}](${article.baseURI})`
      links.push(link)
    }

    const markdown = links.join(`\n`)
    await copyToClipboardInTab(tab.id, markdown);
  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy as markdown link: " + error);
  }
}
// function to copy markdown to the clipboard, triggered by context menu
async function copyMarkdownFromContext(info, tab) {
  try {
    const platformOS = navigator.platform;
    var folderSeparator = "";
    if (platformOS.indexOf("Win") === 0) {
      folderSeparator = "\\";
    } else {
      folderSeparator = "/";
    }

    if (info.menuItemId == "copy-markdown-link") {
      const options = await getOptions();
      options.frontmatter = options.backmatter = '';
      const article = await getArticleFromContent(tab.id, false);
      const response = await offscreen({
        type: 'turndown-string',
        content: `<a href="${info.linkUrl}">${info.linkText || info.selectionText}</a>`,
        article,
        options: { ...options, downloadImages: false }
      });
      await copyToClipboardInTab(tab.id, response.markdown);
    }
    else if (info.menuItemId == "copy-markdown-image") {
      await copyToClipboardInTab(tab.id, `![](${info.srcUrl})`);
    }
    else if (info.menuItemId == "copy-markdown-obsidian") {
      const article = await getArticleFromContent(tab.id, true);
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(article, false);
      await copyToClipboardInTab(tab.id, markdown);
      await chrome.tabs.update({ url: "obsidian://advanced-uri?vault=" + obsidianVault + "&clipboard=true&mode=new&filepath=" + obsidianFolder + sanitizeObsidianName(title) });
    }
    else if (info.menuItemId == "copy-markdown-obsall") {
      const article = await getArticleFromContent(tab.id, false);
      const title = await formatTitle(article);
      const options = await getOptions();
      const obsidianVault = options.obsidianVault;
      const obsidianFolder = await formatObsidianFolder(article);
      const { markdown } = await convertArticleToMarkdown(article, false);
      await copyToClipboardInTab(tab.id, markdown);
      await chrome.tabs.update({ url: "obsidian://advanced-uri?vault=" + obsidianVault + "&description=true&mode=new&filepath=" + obsidianFolder + sanitizeObsidianName(title) });
    }
    else {
      const article = await getArticleFromContent(tab.id, info.menuItemId == "copy-markdown-selection");
      const { markdown } = await convertArticleToMarkdown(article, false);
      await copyToClipboardInTab(tab.id, markdown);
    }
  }
  catch (error) {
    // This could happen if the extension is not allowed to run code in
    // the page, for example if the tab is a privileged page.
    console.error("Failed to copy text: " + error);
  }
}

// Remove characters that break the obsidian://... URI query string
function sanitizeObsidianName(title) {
  return encodeURIComponent(generateValidFileName(title, "[]#^"));
}

async function downloadMarkdownForAllTabs(info) {
  const tabs = await chrome.tabs.query({
    currentWindow: true
  });
  tabs.forEach(tab => {
    downloadMarkdownFromContext(info, tab).catch(error => {
      console.error("Failed to download for tab: " + error);
    });
  });
}