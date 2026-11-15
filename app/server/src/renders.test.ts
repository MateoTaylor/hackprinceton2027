import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Hono } from 'hono'
import { mountRenders } from './renders.ts'

const root = await mkdtemp(join(tmpdir(), 'renders-'))
after(() => rm(root, { recursive: true, force: true }))

const place = join(root, 'some-place')
await mkdir(join(place, '01-pillow'), { recursive: true })
await writeFile(join(place, 'edits.json'), JSON.stringify({ model_id: 'Model123abc', edits: [{ name: '01-pillow', command: 'remove the pillow' }] }))
await writeFile(
  join(place, '01-pillow', 'edit.json'),
  JSON.stringify({ panos: [{ id: 'sweepA', views: [{ before: 'p1_v0_before.jpg', edited: 'p1_v0_edited.jpg', mask: 'p1_v0_mask.png', yaw: 78, pitch: -21, fov: 70, width: 1024, height: 1024, report: {} }] }] }),
)
await writeFile(join(place, '01-pillow', 'p1_v0_before.jpg'), 'jpeg bytes')

const app = new Hono()
mountRenders(app, root)

test('lists each sweep’s before and after pictures and serves them', async () => {
  const listed = await (await app.request('/api/renders/Model123abc')).json()
  assert.deepEqual(listed, {
    sweeps: {
      sweepA: [
        {
          command: 'remove the pillow',
          before: '/api/renders/Model123abc/01-pillow/p1_v0_before.jpg',
          after: '/api/renders/Model123abc/01-pillow/p1_v0_edited.jpg',
          mask: '/api/renders/Model123abc/01-pillow/p1_v0_mask.png',
          view: { yaw: 78, pitch: -21, fov: 70, width: 1024, height: 1024 },
        },
      ],
    },
  })
  const picture = await app.request(listed.sweeps.sweepA[0].before)
  assert.equal(picture.status, 200)
  assert.equal(await picture.text(), 'jpeg bytes')
})

test('answers no sweeps for another model and refuses names outside an edit folder', async () => {
  assert.deepEqual(await (await app.request('/api/renders/Other123abc')).json(), { sweeps: {} })
  assert.equal((await app.request('/api/renders/Model123abc/01-pillow/edit.json')).status, 404)
  assert.equal((await app.request('/api/renders/Model123abc/..%2F..%2Fx/p.jpg')).status, 404)
})
