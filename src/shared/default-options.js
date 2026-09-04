// these are the default options
const defaultOptions = {
  headingStyle: "atx",
  hr: "___",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "_",
  strongDelimiter: "**",
  linkStyle: "inlined",
  linkReferenceStyle: "full",
  imageStyle: "markdown",
  imageRefStyle: "inlined",
  frontmatter: "---\ncreated: {date:YYYY-MM-DDTHH:mm:ss} (UTC {date:Z})\ntags: [{keywords}]\nsource: {baseURI}\nauthor: {byline}\n---\n\n# {pageTitle}\n\n> ## Excerpt\n> {excerpt}\n\n---",
  backmatter: "",
  title: "{pageTitle}",
  includeTemplate: false,
  // Popup-only toggle: clip only the selected text instead of the whole page.
  // Toggled in the popup ("Selected Text" / "Entire Document"), read here so
  // getOptions() returns it for the service worker's clip-tab fallback.
  clipSelection: true,
  saveAs: false,
  downloadImages: false,
  imagePrefix: '{pageTitle}/',
  mdClipsFolder: null,
  disallowedChars: '[]#^',
  downloadMode: 'downloadsApi',
  turndownEscape: true,
  contextMenus: true,
  obsidianIntegration: false,
  obsidianVault: "",
  obsidianFolder: "",
}

// function to get the options from storage and substitute default options if it fails
// NOTE: offscreen documents cannot use chrome.storage; they always receive a
// fully-populated options object from the service worker instead.
async function getOptions() {
  let options = defaultOptions;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      options = await chrome.storage.sync.get(defaultOptions);
      if (!chrome.downloads) options.downloadMode = 'contentLink';
    }
  } catch (err) {
    console.error(err);
  }
  return options;
}