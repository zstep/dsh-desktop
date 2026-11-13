// Public download packages use the production identity, never the isolated Dev
// profile. They are deliberately unsigned and do not publish an update feed.
const { build, version } = require('./package.json')
const publicVersion = version.replace(/\+pengbao\.([1-9]\d*)$/, '.$1')

module.exports = {
  ...build,
  buildVersion: publicVersion,
  extraMetadata: { ...build.extraMetadata, shortVersion: publicVersion, shortVersionWindows: publicVersion },
  publish: null,
  afterSign: null,
  mac: { ...build.mac, bundleShortVersion: publicVersion, identity: null, notarize: false },
  win: { ...build.win, signtoolOptions: { ...build.win.signtoolOptions, sign: null } }
}
