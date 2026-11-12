// Public download packages use the production identity, never the isolated Dev
// profile. They are deliberately unsigned and do not publish an update feed.
const { build } = require('./package.json')

module.exports = {
  ...build,
  publish: null,
  afterSign: null,
  mac: { ...build.mac, identity: null, notarize: false },
  win: { ...build.win, signtoolOptions: { ...build.win.signtoolOptions, sign: null } }
}
