
// default variables
var selectedText = null;
var imageList = null;
var mdClipsFolder = '';

const darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
// set up event handlers
const cm = CodeMirror.fromTextArea(document.getElementById("md"), {
    theme: darkMode ? "xq-dark" : "xq-light",
    mode: "markdown",
    lineWrapping: true
});
cm.on("cursorActivity", (cm) => {
    const somethingSelected = cm.somethingSelected();
    var a = document.getElementById("downloadSelection");

    if (somethingSelected) {
        if(a.style.display != "block") a.style.display = "block";
    }
    else {
        if(a.style.display != "none") a.style.display = "none";
    }
});
document.getElementById("download").addEventListener("click", download);
document.getElementById("downloadSelection").addEventListener("click", downloadSelection);

const defaultOptions = {
    includeTemplate: false,
    clipSelection: true,
    downloadImages: false
}

const checkInitialSettings = options => {
    if (options.includeTemplate)
        document.querySelector("#includeTemplate").classList.add("checked");

    if (options.downloadImages)
        document.querySelector("#downloadImages").classList.add("checked");

    if (options.clipSelection)
        document.querySelector("#selected").classList.add("checked");
    else
        document.querySelector("#document").classList.add("checked");
}

const toggleClipSelection = options => {
    options.clipSelection = !options.clipSelection;
    document.querySelector("#selected").classList.toggle("checked");
    document.querySelector("#document").classList.toggle("checked");
    chrome.storage.sync.set(options).then(() => clipSite()).catch((error) => {
        console.error(error);
    });
}

const toggleIncludeTemplate = options => {
    options.includeTemplate = !options.includeTemplate;
    document.querySelector("#includeTemplate").classList.toggle("checked");
    chrome.storage.sync.set(options).then(() => {
        chrome.contextMenus.update("toggle-includeTemplate", {
            checked: options.includeTemplate
        }).catch(() => {});
        try {
            chrome.contextMenus.update("tabtoggle-includeTemplate", {
                checked: options.includeTemplate
            }).catch(() => {});
        } catch { }
        return clipSite()
    }).catch((error) => {
        console.error(error);
    });
}

const toggleDownloadImages = options => {
    options.downloadImages = !options.downloadImages;
    document.querySelector("#downloadImages").classList.toggle("checked");
    chrome.storage.sync.set(options).then(() => {
        chrome.contextMenus.update("toggle-downloadImages", {
            checked: options.downloadImages
        }).catch(() => {});
        try {
            chrome.contextMenus.update("tabtoggle-downloadImages", {
                checked: options.downloadImages
            }).catch(() => {});
        } catch { }
    }).catch((error) => {
        console.error(error);
    });
}
const showOrHideClipOption = selection => {
    if (selection) {
        document.getElementById("clipOption").style.display = "flex";
    }
    else {
        document.getElementById("clipOption").style.display = "none";
    }
}

const clipSite = tabId => {
    // Ask the service worker to clip the tab. The SW resolves the tab, injects
    // the content script if it is missing (e.g. a tab that outlived an
    // extension install/reload), converts via the offscreen document, and
    // broadcasts "display.md" back to us - so this can never hit the
    // "Receiving end does not exist" error the direct tabs.sendMessage call
    // used to produce.
    return chrome.runtime.sendMessage({
        type: "clip-tab",
        tabId: tabId
    }).then((result) => {
        if (result && result.ok) {
            showOrHideClipOption(result.selection);
        } else {
            const err = (result && result.error) || 'Unknown error clipping the page.';
            console.error(err);
            showError(err);
        }
    }).catch(err => {
        console.error(err);
        showError(err);
    });
}

// inject the necessary scripts
chrome.storage.sync.get(defaultOptions).then(options => {
    checkInitialSettings(options);
    
    document.getElementById("selected").addEventListener("click", (e) => {
        e.preventDefault();
        toggleClipSelection(options);
    });
    document.getElementById("document").addEventListener("click", (e) => {
        e.preventDefault();
        toggleClipSelection(options);
    });
    document.getElementById("includeTemplate").addEventListener("click", (e) => {
        e.preventDefault();
        toggleIncludeTemplate(options);
    });
    document.getElementById("downloadImages").addEventListener("click", (e) => {
        e.preventDefault();
        toggleDownloadImages(options);
    });
    
    return chrome.tabs.query({
        currentWindow: true,
        active: true
    });
}).then((tabs) => {
    var id = tabs[0].id;
    // Ask the service worker to clip this tab. The SW reads the page payload
    // (injecting the content script if needed), converts via the offscreen
    // document, and broadcasts "display.md" which notify() renders below.
    return clipSite(id).catch((error) => {
        console.error(error);
        showError(error);
    });
});

// listen for notifications from the background page
chrome.runtime.onMessage.addListener(notify);

//function to send the download message to the background page
function sendDownloadMessage(text) {
    if (text != null) {

        return chrome.tabs.query({
            currentWindow: true,
            active: true
        }).then(tabs => {
            var message = {
                type: "download",
                markdown: text,
                title: document.getElementById("title").value,
                tab: tabs[0],
                imageList: imageList,
                mdClipsFolder: mdClipsFolder
            };
            return chrome.runtime.sendMessage(message);
        });
    }
}

// event handler for download button
async function download(e) {
    e.preventDefault();
    await sendDownloadMessage(cm.getValue());
    window.close();
}

// event handler for download selected button
async function downloadSelection(e) {
    e.preventDefault();
    if (cm.somethingSelected()) {
        await sendDownloadMessage(cm.getSelection());
    }
}

//function that handles messages from the injected script into the site
function notify(message) {
    // message for displaying markdown
    if (message.type == "display.md") {

        // set the values from the message
        //document.getElementById("md").value = message.markdown;
        cm.setValue(message.markdown);
        document.getElementById("title").value = message.article.title;
        imageList = message.imageList;
        mdClipsFolder = message.mdClipsFolder;
        
        // show the hidden elements
        document.getElementById("container").style.display = 'flex';
        document.getElementById("spinner").style.display = 'none';
         // focus the download button
        document.getElementById("download").focus();
        cm.refresh();
    }
}

function showError(err) {
    // show the hidden elements
    document.getElementById("container").style.display = 'flex';
    document.getElementById("spinner").style.display = 'none';
    cm.setValue(`Error clipping the page\n\n${err}`)
}

