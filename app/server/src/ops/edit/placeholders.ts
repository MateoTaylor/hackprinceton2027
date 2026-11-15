// Writes placeholder before and after pictures and a manifest into the demo property's drop
// folder, so the Magic Eraser and Remodel panels run before the real pictures arrive. It never
// overwrites a folder that already has a manifest. Run it from the repo root:
//   node app/server/src/ops/edit/placeholders.ts
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { dropRoot, Manifest } from './drop.ts'

const PROPERTY_ID = 'residential-201926017'
const W = 960
const H = 540

type Rgb = readonly [number, number, number]

// A plain RGB canvas with rectangles, lines and a 5 by 7 pixel font for the few capitals the labels use.
class Canvas {
  readonly pixels = new Uint8Array(W * H * 3)

  rect(x: number, y: number, w: number, h: number, [r, g, b]: Rgb) {
    for (let row = Math.max(0, y); row < Math.min(H, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(W, x + w); col++) this.pixels.set([r, g, b], (row * W + col) * 3)
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: Rgb) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let i = 0; i <= steps; i++) this.rect(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), width, width, colour)
  }

  text(x: number, y: number, words: string, scale: number, colour: Rgb) {
    ;[...words].forEach((char, index) => {
      ;(GLYPHS[char] ?? []).forEach((row, dy) => {
        ;[...row].forEach((bit, dx) => bit === '1' && this.rect(x + (index * 6 + dx) * scale, y + dy * scale, scale, scale, colour))
      })
    })
  }

  png() {
    const raw = Buffer.alloc((W * 3 + 1) * H)
    for (let row = 0; row < H; row++) raw.set(this.pixels.subarray(row * W * 3, (row + 1) * W * 3), row * (W * 3 + 1) + 1)
    const header = Buffer.alloc(13)
    header.writeUInt32BE(W, 0)
    header.writeUInt32BE(H, 4)
    header.set([8, 2, 0, 0, 0], 8)
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
}

const WALL: Rgb = [198, 190, 176]
const LABEL: Rgb = [178, 59, 51]

// A room with a wall, a floor and a sofa, labelled as a placeholder.
function room(floor: Rgb, label: 'BEFORE' | 'AFTER') {
  const canvas = new Canvas()
  canvas.rect(0, 0, W, H, WALL)
  canvas.rect(0, 360, W, 180, floor)
  canvas.rect(300, 250, 360, 120, [92, 104, 120])
  canvas.rect(300, 220, 360, 50, [110, 122, 138])
  canvas.rect(140, 70, 180, 130, [150, 170, 190])
  canvas.text(24, 24, `PLACEHOLDER ${label}`, 4, LABEL)
  return canvas
}

function planks(canvas: Canvas, colour: Rgb) {
  for (let y = 380; y < H; y += 32) canvas.rect(0, y, W, 2, colour)
}

function lamp(canvas: Canvas) {
  canvas.rect(744, 210, 70, 54, [236, 214, 160])
  canvas.rect(776, 264, 6, 150, [60, 56, 52])
  canvas.rect(752, 410, 54, 8, [60, 56, 52])
}

function kitchen(top: Rgb, label: 'BEFORE' | 'AFTER', veins: boolean) {
  const canvas = new Canvas()
  canvas.rect(0, 0, W, H, WALL)
  canvas.rect(0, 440, W, 100, [120, 110, 98])
  canvas.rect(80, 300, 800, 140, [70, 82, 76])
  for (let x = 80; x < 880; x += 160) canvas.rect(x, 300, 3, 140, [52, 62, 57])
  canvas.rect(70, 270, 820, 30, top)
  if (veins) for (let x = 90; x < 840; x += 70) canvas.line(x, 272, x + 40, 297, 1, [170, 172, 178])
  canvas.rect(80, 60, 800, 120, [70, 82, 76])
  canvas.text(24, 200, `PLACEHOLDER ${label}`, 4, LABEL)
  return canvas
}

const pictures: Record<string, Canvas> = {
  'lamp-before.png': (() => {
    const canvas = room([110, 84, 60], 'BEFORE')
    planks(canvas, [90, 68, 48])
    lamp(canvas)
    return canvas
  })(),
  'lamp-after.png': (() => {
    const canvas = room([110, 84, 60], 'AFTER')
    planks(canvas, [90, 68, 48])
    return canvas
  })(),
  'countertop-before.png': kitchen([84, 62, 44], 'BEFORE', false),
  'countertop-after.png': kitchen([232, 232, 228], 'AFTER', true),
  'floor-before.png': (() => {
    const canvas = room([110, 84, 60], 'BEFORE')
    planks(canvas, [90, 68, 48])
    return canvas
  })(),
  'floor-after.png': (() => {
    const canvas = room([214, 184, 140], 'AFTER')
    planks(canvas, [190, 160, 118])
    return canvas
  })(),
}

const manifest = Manifest.parse({
  edits: [
    { id: 'remove-floor-lamp', tool: 'erase', command: 'Remove the floor lamp', where: 'Living room (placeholder)', before: 'lamp-before.png', after: 'lamp-after.png' },
    { id: 'marble-countertop', tool: 'remodel', command: 'Make the countertop white marble', where: 'Kitchen (placeholder)', before: 'countertop-before.png', after: 'countertop-after.png' },
    { id: 'light-oak-floor', tool: 'remodel', command: 'Change the floor to light oak', where: 'Living room (placeholder)', before: 'floor-before.png', after: 'floor-after.png' },
  ],
})

const folder = join(dropRoot(fileURLToPath(new URL('../../../../../data/propstar/', import.meta.url))), PROPERTY_ID)
if (await stat(join(folder, 'manifest.json')).then(() => true, () => false)) {
  console.log('The drop folder already has a manifest; nothing written.')
} else {
  await mkdir(folder, { recursive: true })
  await Promise.all(Object.entries(pictures).map(([name, canvas]) => writeFile(join(folder, name), canvas.png())))
  await writeFile(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(pictures).length} placeholder pictures and a manifest for ${PROPERTY_ID}.`)
}
