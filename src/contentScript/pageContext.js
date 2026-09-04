function addLatexToMathJax3()
{
    // Guard against pages without MathJax: a bare `MathJax?.` throws a
    // ReferenceError if the global is not declared at all.
    if (typeof MathJax === 'undefined' || !MathJax?.startup?.document?.math)
        return

    for (const item of MathJax.startup.document.math)
    {
        item.typesetRoot.setAttribute("markdownload-latex", item.math)
    }
}
addLatexToMathJax3()
