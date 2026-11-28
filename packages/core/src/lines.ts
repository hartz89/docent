/** How many lines a file has. A final newline ends the last line; it doesn't start another. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/).length;
  return /\r?\n$/.test(text) ? lines - 1 : lines;
}

/**
 * A link to one line of a file on GitHub, at a commit. Each path segment is percent-encoded,
 * brackets and quotes too, so a file name can't end a markdown link early. The server writes it
 * into the review body and the web app shows the same link in the preview.
 */
export function githubLineUrl(repo: string, sha: string, path: string, line: number): string {
  const encoded = path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
  return `https://github.com/${repo}/blob/${sha}/${encoded}#L${line}`;
}
