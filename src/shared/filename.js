// Shared (DOM-free) utility: turn a title string into a valid file name.
// Used by both the service worker (background) and the offscreen document.

// function to turn the title into a valid file name
function generateValidFileName(title, disallowedChars = null) {
  if (!title) return title;
  else title = title + '';
  // remove < > : " / \ | ? * 
  var illegalRe = /[\/\?<>\\:\*\|":]/g;
  // and non-breaking spaces (thanks @Licat)
  var name = title.replace(illegalRe, "").replace(new RegExp('\u00A0', 'g'), ' ')
      // collapse extra whitespace
      .replace(new RegExp(/\s+/, 'g'), ' ')
      // remove leading/trailing whitespace that can cause issues when using {pageTitle} in a download path
      .replace(new RegExp(/^\s+|\s+$/g), '')
      // remove trailing dots, which causes issues when giving the file an extension
      .replace(new RegExp(/\.$/, 'g'), '');

  if (disallowedChars != null) {
    const disallowed = [...disallowedChars];
    for (let c of disallowed) {
      if (`[\\^$.|?*+()`.includes(c)) c = `\\${c}`;
      name = name.replace(new RegExp(c, 'g'), '');
    }
  }
  
  return name;
}