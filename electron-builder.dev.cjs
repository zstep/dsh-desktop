const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'net.ecombus.pengbao.desktop.dev',
  productName: 'Pengbao AI Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'pengbao-ai-dev',
    productName: 'Pengbao AI Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'pengbao-ai-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'pengbao-ai-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
