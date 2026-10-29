import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const sourcePath = path.join(buildDirectory, 'pengbao-b2-source.jpeg')
const markPath = path.join(buildDirectory, 'pengbao-b2-mark.png')

// The approved source image places the clean Teal on Black mark in panel A.
const crop = { left: 180, top: 470, width: 700, height: 700 }
const transparent = { r: 0, g: 0, b: 0, alpha: 0 }
const teal = { r: 28, g: 198, b: 196 }

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

function createTealMark(raw) {
  const rgba = Buffer.alloc(raw.info.width * raw.info.height * 4)
  for (let index = 0; index < raw.data.length; index += 3) {
    const red = raw.data[index]
    const green = raw.data[index + 1]
    const blue = raw.data[index + 2]
    const chroma = (green + blue) / 2 - red
    const alpha = clamp(Math.round((chroma - 6) * 1.8), 0, 255)
    const offset = (index / 3) * 4
    rgba[offset] = red
    rgba[offset + 1] = green
    rgba[offset + 2] = blue
    rgba[offset + 3] = alpha
  }
  return sharp(rgba, {
    raw: { width: raw.info.width, height: raw.info.height, channels: 4 }
  }).trim({ background: transparent, threshold: 1 })
}

async function centeredLogo(mark, color) {
  const { data, info } = await mark.clone().raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let index = 0; index < data.length; index += 4) {
    const offset = index
    rgba[offset] = color.r
    rgba[offset + 1] = color.g
    rgba[offset + 2] = color.b
    rgba[offset + 3] = data[offset + 3]
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize({ width: 290, height: 176, fit: 'contain', background: transparent })
    .extend({ top: 8, bottom: 8, left: 23, right: 23, background: transparent })
    .png()
    .toBuffer()
}

function simplify(points) {
  const result = []
  for (const point of points) {
    const previous = result.at(-1)
    const before = result.at(-2)
    if (before && previous && (before[0] - previous[0]) * (point[1] - previous[1])
      === (before[1] - previous[1]) * (point[0] - previous[0])) {
      result[result.length - 1] = point
    } else {
      result.push(point)
    }
  }
  return result
}

function vectorPath(data, width, height) {
  const edges = []
  const outgoing = new Map()
  const key = (x, y) => `${x},${y}`
  const add = (start, end) => {
    const edge = { start, end, used: false }
    edges.push(edge)
    const startKey = key(...start)
    const list = outgoing.get(startKey) ?? []
    list.push(edge)
    outgoing.set(startKey, list)
  }
  const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height
    && data[(y * width + x) * 4 + 3] >= 128
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!filled(x, y)) continue
      if (!filled(x, y - 1)) add([x, y], [x + 1, y])
      if (!filled(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
      if (!filled(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
      if (!filled(x - 1, y)) add([x, y + 1], [x, y])
    }
  }
  const scaleX = 1000 / width
  const scaleY = 1000 / height
  const paths = []
  for (const first of edges) {
    if (first.used) continue
    const points = []
    let edge = first
    while (!edge.used) {
      edge.used = true
      points.push(edge.start)
      const next = (outgoing.get(key(...edge.end)) ?? []).find((candidate) => !candidate.used)
      if (!next) break
      edge = next
    }
    const simplified = simplify(points)
    if (simplified.length < 3) continue
    const commands = simplified.map(([x, y], index) => {
      const px = Math.round(x * scaleX * 10) / 10
      const py = Math.round(y * scaleY * 10) / 10
      return `${index === 0 ? 'M' : 'L'}${px} ${py}`
    })
    paths.push(`${commands.join(' ')} Z`)
  }
  return paths.join(' ')
}

const source = await readFile(sourcePath)
const raw = await sharp(source).extract(crop).raw().toBuffer({ resolveWithObject: true })
const mark = createTealMark(raw)
const markPng = await mark.png().toBuffer()
const markInfo = await sharp(markPng).metadata()
await writeFile(markPath, markPng)

const darkLogo = await centeredLogo(sharp(markPng), teal)
const lightLogo = await centeredLogo(sharp(markPng), { r: 0, g: 0, b: 0 })
await writeFile(path.join(buildDirectory, 'logo-dark.png'), darkLogo)
await writeFile(path.join(buildDirectory, 'logo-light.png'), lightLogo)

const iconBackground = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">'
  + '<rect x="16" y="16" width="992" height="992" rx="224" fill="#070b0c"/></svg>'
)
const iconMark = await sharp(markPng).resize({ width: 700, height: 700, fit: 'contain', background: transparent }).png().toBuffer()
await sharp(iconBackground)
  .composite([{ input: iconMark, gravity: 'center' }])
  .png()
  .toFile(path.join(buildDirectory, 'app-icon.png'))

const markData = markPng.toString('base64')
const brandSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" fill="none"><image href="data:image/png;base64,${markData}" x="150" y="90" width="700" height="820" preserveAspectRatio="xMidYMid meet"/></svg>\n`
await writeFile(path.join(buildDirectory, 'brand-mark.svg'), brandSvg)

console.log(`Generated Teal on Black brand assets from ${path.relative(projectRoot, sourcePath)} (${markInfo.width}x${markInfo.height} mark).`)
