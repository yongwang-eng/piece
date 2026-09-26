// Reuse of a leased secret is observable at two moments: a warm unlock, and a command that NAMES a leased var.
// A script reading the env without naming it is invisible here — the sanctioned use is `$VAR` by name, so that is the shape watched.

/** Secret names whose env vars the command text references (`$VAR` or `${VAR}`), in first-seen order. */
export function usedVars(command: string, leased: Map<string, string>): string[] {
  const hits: [number, string][] = [];
  for (const [envVar, name] of leased) {
    const at = command.search(new RegExp(`\\$(?:\\{[#!]?)?${envVar}\\b(?![\\w])`));
    if (at >= 0 && !hits.some((h) => h[1] === name)) hits.push([at, name]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
}
