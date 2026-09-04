// ---------------------------------------------------------------------------
// MarkDownload - offscreen document logic
//
// Manifest V3 service workers have no DOM, so all the page-DOM-dependent work
// (Reading the DOM string with Mozilla Readability, converting HTML to
// Markdown with Turndown, downloading images) must run inside this hidden
// offscreen document, which is a normal extension page with a full DOM.
//
// The service worker (background) routes work to this document by sending a
// chrome.runtime message with `target: "offscreen"`. This document answers
// each message asynchronously via sendResponse.
// ---------------------------------------------------------------------------

// Options are supplied by the service worker on every routed message, because
// offscreen documents cannot use chrome.storage. default-options.js is loaded
// only as a last-resort fallback if a message ever arrives without options.

// ---------------------------------------------------------------------------
// Turndown conversion
// ---------------------------------------------------------------------------

TurndownService.prototype.defaultEscape = TurndownService.prototype.escape;

// function to convert the article content to markdown using Turndown
function turndown(content, options, article) {

  if (options.turndownEscape) TurndownService.prototype.escape = TurndownService.prototype.defaultEscape;
  else TurndownService.prototype.escape = s => s;

  var turndownService = new TurndownService(options);

  turndownService.use(turndownPluginGfm.gfm)

  turndownService.keep(['iframe', 'sub', 'sup', 'u', 'ins', 'del', 'small', 'big']);

  let imageList = {};
  // add an image rule
  turndownService.addRule('images', {
    filter: function (node, tdopts) {
      // if we're looking at an img node with a src
      if (node.nodeName == 'IMG' && node.getAttribute('src')) {
        
        // get the original src
        let src = node.getAttribute('src')
        // set the new src
        node.setAttribute('src', validateUri(src, article.baseURI));
        
        // if we're downloading images, there's more to do.
        if (options.downloadImages) {
          // generate a file name for the image
          let imageFilename = getImageFilename(src, options, false);
          if (!imageList[src] || imageList[src] != imageFilename) {
            // if the imageList already contains this file, add a number to differentiate
            let i = 1;
            while (Object.values(imageList).includes(imageFilename)) {
              const parts = imageFilename.split('.');
              if (i == 1) parts.splice(parts.length - 1, 0, i++);
              else parts.splice(parts.length - 2, 1, i++);
              imageFilename = parts.join('.');
            }
            // add it to the list of images to download later
            imageList[src] = imageFilename;
          }
          // check if we're doing an obsidian style link
          const obsidianLink = options.imageStyle.startsWith("obsidian");
          // figure out the (local) src of the image
          const localSrc = options.imageStyle === 'obsidian-nofolder'
            // if using "nofolder" then we just need the filename, no folder
            ? imageFilename.substring(imageFilename.lastIndexOf('/') + 1)
            // otherwise we may need to modify the filename to uri encode parts for a pure markdown link
            : imageFilename.split('/').map(s => obsidianLink ? s : encodeURI(s)).join('/')
          
          // set the new src attribute to be the local filename
          if(options.imageStyle != 'originalSource' && options.imageStyle != 'base64') node.setAttribute('src', localSrc);
          // pass the filter if we're making an obsidian link (or stripping links)
          return true;
        }
        else return true
      }
      // don't pass the filter, just output a normal markdown link
      return false;
    },
    replacement: function (content, node, tdopts) {
      // if we're stripping images, output nothing
      if (options.imageStyle == 'noImage') return '';
      // if this is an obsidian link, so output that
      else if (options.imageStyle.startsWith('obsidian')) return `![[${node.getAttribute('src')}]]`;
      // otherwise, output the normal markdown link
      else {
        var alt = cleanAttribute(node.getAttribute('alt'));
        var src = node.getAttribute('src') || '';
        var title = cleanAttribute(node.getAttribute('title'));
        var titlePart = title ? ' "' + title + '"' : '';
        if (options.imageRefStyle == 'referenced') {
          var id = this.references.length + 1;
          this.references.push('[fig' + id + ']: ' + src + titlePart);
          return '![' + alt + '][fig' + id + ']';
        }
        else return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : ''
      }
    },
    references: [],
    append: function (options) {
      var references = '';
      if (this.references.length) {
        references = '\n\n' + this.references.join('\n') + '\n\n';
        this.references = []; // Reset references
      }
      return references
    }

  });

  // add a rule for links
  turndownService.addRule('links', {
    filter: (node, tdopts) => {
      // check that this is indeed a link
      if (node.nodeName == 'A' && node.getAttribute('href')) {
        // get the href
        const href = node.getAttribute('href');
        // set the new href
        node.setAttribute('href', validateUri(href, article.baseURI));
        // if we are to strip links, the filter needs to pass
        return options.linkStyle == 'stripLinks';
      }
      // we're not passing the filter, just do the normal thing.
      return false;
    },
    // if the filter passes, we're stripping links, so just return the content
    replacement: (content, node, tdopts) => content
  });

  // handle multiple lines math
  turndownService.addRule('mathjax', {
    filter(node, options) {
      return article.math.hasOwnProperty(node.id);
    },
    replacement(content, node, options) {
      const math = article.math[node.id];
      let tex = math.tex.trim().replaceAll('\xa0', '');

      if (math.inline) {
        tex = tex.replaceAll('\n', ' ');
        return `$${tex}$`;
      }
      else
        return `$$\n${tex}\n$$`;
    }
  });

  function repeat(character, count) {
    return Array(count + 1).join(character);
  }

  function convertToFencedCodeBlock(node, options) {
    node.innerHTML = node.innerHTML.replaceAll('<br-keep></br-keep>', '<br>');
    const langMatch = node.id?.match(/code-lang-(.+)/);
    const language = langMatch?.length > 0 ? langMatch[1] : '';

    const code = node.innerText;

    const fenceChar = options.fence.charAt(0);
    let fenceSize = 3;
    const fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');

    let match;
    while ((match = fenceInCodeRegex.exec(code))) {
      if (match[0].length >= fenceSize) {
        fenceSize = match[0].length + 1;
      }
    }

    const fence = repeat(fenceChar, fenceSize);

    return (
      '\n\n' + fence + language + '\n' +
      code.replace(/\n$/, '') +
      '\n' + fence + '\n\n'
    )
  }

  turndownService.addRule('fencedCodeBlock', {
    filter: function (node, options) {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild &&
        node.firstChild.nodeName === 'CODE'
      );
    },
    replacement: function (content, node, options) {
      return convertToFencedCodeBlock(node.firstChild, options);
    }
  });

  // handle <pre> as code blocks
  turndownService.addRule('pre', {
    filter: (node, tdopts) => {
      return node.nodeName == 'PRE'
             && (!node.firstChild || node.firstChild.nodeName != 'CODE')
             && !node.querySelector('img');
    },
    replacement: (content, node, tdopts) => {
      return convertToFencedCodeBlock(node, tdopts);
    }
  });

  let markdown = options.frontmatter + turndownService.turndown(content)
      + options.backmatter;

  // strip out non-printing special characters which CodeMirror displays as a red dot
  // see: https://codemirror.net/doc/manual.html#option_specialChars
  markdown = markdown.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]/g, '');

  return { markdown: markdown, imageList: imageList };
}

function cleanAttribute(attribute) {
  return attribute ? attribute.replace(/(\n+\s*)+/g, '\n') : ''
}

function validateUri(href, baseURI) {
  // check if the href is a valid url
  try {
    new URL(href);
  }
  catch {
    // if it's not a valid url, that likely means we have to prepend the base uri
    const baseUri = new URL(baseURI);

    // if the href starts with '/', we need to go from the origin
    if (href.startsWith('/')) {
      href = baseUri.origin + href
    }
    // otherwise we need to go from the local folder
    else {
      href = baseUri.href + (baseUri.href.endsWith('/') ? '/' : '') + href
    }
  }
  return href;
}

function getImageFilename(src, options, prependFilePath = true) {
  const slashPos = src.lastIndexOf('/');
  const queryPos = src.indexOf('?');
  let filename = src.substring(slashPos + 1, queryPos > 0 ? queryPos : src.length);

  let imagePrefix = (options.imagePrefix || '');

  if (prependFilePath && options.title.includes('/')) {
    imagePrefix = options.title.substring(0, options.title.lastIndexOf('/') + 1) + imagePrefix;
  }
  else if (prependFilePath) {
    imagePrefix = options.title + (imagePrefix.startsWith('/') ? '' : '/') + imagePrefix
  }
  
  if (filename.includes(';base64,')) {
    // this is a base64 encoded image, so what are we going to do for a filename here?
    filename = 'image.' + filename.substring(0, filename.indexOf(';'));
  }
  
  let extension = filename.substring(filename.lastIndexOf('.'));
  if (extension == filename) {
    // there is no extension, so we need to figure one out
    // for now, give it an 'idunno' extension and we'll process it later
    filename = filename + '.idunno';
  }

  filename = generateValidFileName(filename, options.disallowedChars);

  return imagePrefix + filename;
}

// function to replace placeholder strings with article info
function textReplace(string, article, disallowedChars = null) {
  for (const key in article) {
    if (article.hasOwnProperty(key) && key != "content") {
      let s = (article[key] || '') + '';
      if (s && disallowedChars) s = this.generateValidFileName(s, disallowedChars);

      string = string.replace(new RegExp('{' + key + '}', 'g'), s)
        .replace(new RegExp('{' + key + ':lower}', 'g'), s.toLowerCase())
        .replace(new RegExp('{' + key + ':upper}', 'g'), s.toUpperCase())
        .replace(new RegExp('{' + key + ':kebab}', 'g'), s.replace(/ /g, '-').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed-kebab}', 'g'), s.replace(/ /g, '-'))
        .replace(new RegExp('{' + key + ':snake}', 'g'), s.replace(/ /g, '_').toLowerCase())
        .replace(new RegExp('{' + key + ':mixed_snake}', 'g'), s.replace(/ /g, '_'))
        // For Obsidian Custom Attachment Location plugin, we need to replace spaces with hyphens, but also remove any double hyphens.
        .replace(new RegExp('{' + key + ':obsidian-cal}', 'g'), s.replace(/ /g, '-').replace(/-{2,}/g, "-"))
        .replace(new RegExp('{' + key + ':camel}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()).replace(/^./, (str) => str.toLowerCase()))
        .replace(new RegExp('{' + key + ':pascal}', 'g'), s.replace(/ ./g, (str) => str.trim().toUpperCase()))
    }
  }
// replace date formats
  const now = new Date();
  const dateRegex = /{date:(.+?)}/g
  const matches = string.match(dateRegex);
  if (matches && matches.forEach) {
    matches.forEach(match => {
      const format = match.substring(6, match.length - 1);
      const dateString = moment(now).format(format);
      string = string.replaceAll(match, dateString);
    });
  }

  // replace keywords
  const keywordRegex = /{keywords:?(.*)?}/g
  const keywordMatches = string.match(keywordRegex);
  if (keywordMatches && keywordMatches.forEach) {
    keywordMatches.forEach(match => {
      let seperator = match.substring(10, match.length - 1)
      try {
        seperator = JSON.parse(JSON.stringify(seperator).replace(/\\\\/g, '\\'));
      }
      catch { }
      const keywordsString = (article.keywords || []).join(seperator);
      string = string.replace(new RegExp(match.replace(/\\/g, '\\\\'), 'g'), keywordsString);
    })
  }

  // replace anything left in curly braces
  const defaultRegex = /{(.*?)}/g
  string = string.replace(defaultRegex, '')

  return string;
}

// function to convert an article info object into markdown
// `options` is supplied by the service worker (offscreen documents cannot use
// chrome.storage).
async function convertArticleToMarkdown(article, downloadImages = null, options) {
  options = options || await getOptions();
  if (downloadImages != null) {
    options.downloadImages = downloadImages;
  }

  // substitute front and backmatter templates if necessary
  if (options.includeTemplate) {
    options.frontmatter = textReplace(options.frontmatter, article) + '\n';
    options.backmatter = '\n' + textReplace(options.backmatter, article);
  }
  else {
    options.frontmatter = options.backmatter = '';
  }

  options.imagePrefix = textReplace(options.imagePrefix, article, options.disallowedChars)
    .split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');

  let result = turndown(article.content, options, article);
  if (options.downloadImages && options.downloadMode == 'downloadsApi') {
    // pre-download the images
    result = await preDownloadImages(result.imageList, result.markdown, options);
  }
  return result;
}

// function to turn the title into a valid file name (defined in shared/filename.js)
async function preDownloadImages(imageList, markdown, options) {
  options = options || await getOptions();
  let newImageList = {};
  // originally, I was downloading the markdown file first, then all the images
  // however, in some cases we need to download images *first* so we can get the
  // proper file extension to put into the markdown.
  // so... here we are waiting for all the downloads and replacements to complete
  await Promise.all(Object.entries(imageList).map(([src, filename]) => new Promise((resolve, reject) => {
        // we're doing an xhr so we can get it as a blob and determine filetype
        // before the final save
        const xhr = new XMLHttpRequest();
        xhr.open('GET', src);
        xhr.responseType = "blob";
        xhr.onload = async function () {
          // here's the returned blob
          const blob = xhr.response;

          if (options.imageStyle == 'base64') {
            var reader = new FileReader();
            reader.onloadend = function () {
              markdown = markdown.replaceAll(src, reader.result)
              resolve()
            }
            reader.readAsDataURL(blob);
          }
          else {

            let newFilename = filename;
            if (newFilename.endsWith('.idunno')) {
              // replace any unknown extension with a lookup based on mime type
              newFilename = filename.replace('.idunno', '.' + mimedb[blob.type]);

              // and replace any instances of this in the markdown
              // remember to url encode for replacement if it's not an obsidian link
              if (!options.imageStyle.startsWith("obsidian")) {
                markdown = markdown.replaceAll(filename.split('/').map(s => encodeURI(s)).join('/'), newFilename.split('/').map(s => encodeURI(s)).join('/'))
              }
              else {
                markdown = markdown.replaceAll(filename, newFilename)
              }
            }

            // create an object url for the blob (no point fetching it twice)
            const blobUrl = URL.createObjectURL(blob);

            // add this blob into the new image list
            newImageList[blobUrl] = newFilename;

            // resolve this promise now
            // (the file might not be saved yet, but the blob is and replacements are complete)
            resolve();
          }
        };
        xhr.onerror = function () {
          reject('A network error occurred attempting to download ' + src);
        };
        xhr.send();
  })));

  return { imageList: newImageList, markdown: markdown };
}

// get Readability article info from the dom passed in
async function getArticleFromDom(domString) {
  // parse the dom
  const parser = new DOMParser();
  const dom = parser.parseFromString(domString, "text/html");

  if (dom.documentElement.nodeName == "parsererror") {
    console.error("error while parsing");
  }

  const math = {};

  const storeMathInfo = (el, mathInfo) => {
    let randomId = URL.createObjectURL(new Blob([]));
    randomId = randomId.substring(randomId.length - 36);
    el.id = randomId;
    math[randomId] = mathInfo;
  };

  dom.body.querySelectorAll('script[id^=MathJax-Element-]')?.forEach(mathSource => {
    const type = mathSource.attributes.type.value
    storeMathInfo(mathSource, {
      tex: mathSource.innerText,
      inline: type ? !type.includes('mode=display') : false
    });
  });

  dom.body.querySelectorAll('[markdownload-latex]')?.forEach(mathJax3Node => {
    const tex = mathJax3Node.getAttribute('markdownload-latex')
    const display = mathJax3Node.getAttribute('display')
    const inline = !(display && display === 'true')

    const mathNode = document.createElement(inline ? "i" : "p")
    mathNode.textContent = tex;
    mathJax3Node.parentNode.insertBefore(mathNode, mathJax3Node.nextSibling)
    mathJax3Node.parentNode.removeChild(mathJax3Node)

    storeMathInfo(mathNode, {
      tex: tex,
      inline: inline
    });
  });

  dom.body.querySelectorAll('.katex-mathml')?.forEach(kaTeXNode => {
    storeMathInfo(kaTeXNode, {
      tex: kaTeXNode.querySelector('annotation').textContent,
      inline: true
    });
  });

  dom.body.querySelectorAll('[class*=highlight-text],[class*=highlight-source]')?.forEach(codeSource => {
    const language = codeSource.className.match(/highlight-(?:text|source)-([a-z0-9]+)/)?.[1]
    if (codeSource.firstChild.nodeName == "PRE") {
      codeSource.firstChild.id = `code-lang-${language}`
    }
  });

  dom.body.querySelectorAll('[class*=language-]')?.forEach(codeSource => {
    const language = codeSource.className.match(/language-([a-z0-9]+)/)?.[1]
    codeSource.id = `code-lang-${language}`;
  });

  dom.body.querySelectorAll('pre br')?.forEach(br => {
    // we need to keep <br> tags because they are removed by Readability.js
    br.outerHTML = '<br-keep></br-keep>';
  });

  dom.body.querySelectorAll('.codehilite > pre')?.forEach(codeSource => {
    if (codeSource.firstChild.nodeName !== 'CODE' && !codeSource.className.includes('language')) {
      codeSource.id = `code-lang-text`;
    }
  });

  dom.body.querySelectorAll('h1, h2, h3, h4, h5, h6')?.forEach(header => {
    // Readability.js will strip out headings from the dom if certain words appear in their className
    // See: https://github.com/mozilla/readability/issues/807
    header.className = '';
    header.outerHTML = header.outerHTML;
  });

  // Prevent Readability from removing the <html> element if has a 'class' attribute
  // which matches removal criteria.
  dom.documentElement.removeAttribute('class')

  // simplify the dom into an article
  const article = new Readability(dom).parse();

  // get the base uri from the dom and attach it as important article info
  article.baseURI = dom.baseURI;
  // also grab the page title
  article.pageTitle = dom.title;
  // and some URL info
  const url = new URL(dom.baseURI);
  article.hash = url.hash;
  article.host = url.host;
  article.origin = url.origin;
  article.hostname = url.hostname;
  article.pathname = url.pathname;
  article.port = url.port;
  article.protocol = url.protocol;
  article.search = url.search;

  // make sure the dom has a head
  if (dom.head) {
    // and the keywords, should they exist, as an array
    article.keywords = dom.head.querySelector('meta[name="keywords"]')?.content?.split(',')?.map(s => s.trim());

    // add all meta tags, so users can do whatever they want
    dom.head.querySelectorAll('meta[name][content], meta[property][content]')?.forEach(meta => {
      const key = (meta.getAttribute('name') || meta.getAttribute('property'))
      const val = meta.getAttribute('content')
      if (key && val && !article[key]) {
        article[key] = val;
      }
    })
  }

  article.math = math

  // return the article
  return article;
}
// function to apply the title template
async function formatTitle(article, options) {
  options = options || await getOptions();

  let title = textReplace(options.title, article, options.disallowedChars + '/');
  title = title.split('/').map(s=>generateValidFileName(s, options.disallowedChars)).join('/');
  return title;
}

async function formatMdClipsFolder(article, options) {
  options = options || await getOptions();

  let mdClipsFolder = '';
  if (options.mdClipsFolder && options.downloadMode == 'downloadsApi') {
    mdClipsFolder = textReplace(options.mdClipsFolder, article, options.disallowedChars);
    mdClipsFolder = mdClipsFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!mdClipsFolder.endsWith('/')) mdClipsFolder += '/';
  }

  return mdClipsFolder;
}

async function formatObsidianFolder(article, options) {
  options = options || await getOptions();

  let obsidianFolder = '';
  if (options.obsidianFolder) {
    obsidianFolder = textReplace(options.obsidianFolder, article, options.disallowedChars);
    obsidianFolder = obsidianFolder.split('/').map(s => generateValidFileName(s, options.disallowedChars)).join('/');
    if (!obsidianFolder.endsWith('/')) obsidianFolder += '/';
  }

  return obsidianFolder;
}

// Blob URL helpers - the offscreen document has a DOM, so URL.createObjectURL
// and URL.revokeObjectURL are available here. They are NOT available in a
// Manifest V3 service worker. The service worker creates the blob URL here,
// performs the download via chrome.downloads, then asks us to revoke it.

function createMarkdownBlobUrl(markdown) {
  return URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
}

// ---------------------------------------------------------------------------
// Message router - the service worker sends `{ target: "offscreen", ... }`
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;

  (async () => {
    switch (message.type) {
      case "clip": {
        // Full popup-clipping pipeline. Options come from the service worker
        // (offscreen documents cannot access chrome.storage).
        const article = await getArticleFromDom(message.dom);
        if (message.selection && message.clipSelection) {
          article.content = message.selection;
        }
        const { markdown, imageList } = await convertArticleToMarkdown(article, null, message.options);
        article.title = await formatTitle(article, message.options);
        const mdClipsFolder = await formatMdClipsFolder(article, message.options);
        sendResponse({ ok: true, markdown, article, imageList, mdClipsFolder });
        break;
      }
      case "get-article": {
        const article = await getArticleFromDom(message.dom);
        sendResponse({ ok: true, article });
        break;
      }
      case "convert-article": {
        const { markdown, imageList } = await convertArticleToMarkdown(message.article, message.downloadImages != null ? message.downloadImages : undefined, message.options);
        sendResponse({ ok: true, markdown, imageList });
        break;
      }
      case "turndown-string": {
        const { markdown } = turndown(message.content, { ...message.options, downloadImages: false }, message.article);
        sendResponse({ ok: true, markdown });
        break;
      }
      case "format-title": {
        const title = await formatTitle(message.article, message.options);
        sendResponse({ ok: true, title });
        break;
      }
      case "format-mdclips": {
        const mdClipsFolder = await formatMdClipsFolder(message.article, message.options);
        sendResponse({ ok: true, mdClipsFolder });
        break;
      }
      case "format-obsidian": {
        const obsidianFolder = await formatObsidianFolder(message.article, message.options);
        sendResponse({ ok: true, obsidianFolder });
        break;
      }
      case "create-blob-url": {
        // Create a blob URL for the markdown text (chrome.downloads.download
        // accepts it), so the service worker can download without needing
        // URL.createObjectURL.
        sendResponse({ ok: true, blobUrl: createMarkdownBlobUrl(message.markdown) });
        break;
      }
      case "revoke-blob-url": {
        // Release a blob URL (created here) after the SW's download finished.
        if (message.url && message.url.startsWith('blob:')) {
          URL.revokeObjectURL(message.url);
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown offscreen message type: " + message.type });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });

  // Keep the message channel open for the async response.
  return true;
});