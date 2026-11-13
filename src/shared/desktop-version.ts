/** package.json remains valid SemVer; the fourth component is the Pengbao revision shown to users. */
export function desktopVersion(version: string): string {
  return version.replace(/\+pengbao\.([1-9]\d*)$/, '.$1')
}
