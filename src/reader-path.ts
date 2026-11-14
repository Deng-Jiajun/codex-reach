export type ReaderReference = string | { path: string };

export function readerPath(reference: ReaderReference, root?: string): { path: string; line?: number } {
  let path = typeof reference === 'string' ? reference : reference.path;
  let line: number | undefined;
  if (typeof reference === 'string') {
    const location = /(?::([1-9]\d*)(?::[1-9]\d*)?|#L([1-9]\d*)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(path);
    if (location) {
      line = Number(location[1] ?? location[2]);
      path = path.slice(0, location.index);
    }
    if (/^file:/i.test(path)) {
      const uri = new URL(path);
      path = uri.hostname ? `//${uri.hostname}${uri.pathname}` : uri.pathname;
    }
    try { path = decodeURIComponent(path); } catch { /* Literal percent signs are valid in file names */ }
  }
  path = path.replace(/^\/([a-z]:[/\\])/i, '$1');
  if (!/^[a-z]:[/\\]/i.test(path) && !path.startsWith('/') && !path.startsWith('\\\\') && root) {
    path = `${root.replace(/[/\\]$/, '')}/${path}`;
  }
  return { path, line };
}
