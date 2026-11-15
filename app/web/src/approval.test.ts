import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionRequests, describeAction } from './approval.ts'

test('a sign card prints the ids and numbers with units, and no free text', () => {
  const card = describeAction({
    name: 'signage_place',
    args: { propertyId: 'residential-201926017', facingDeg: 182.456, alongM: 3, bottomM: 4.5, sizeM: { widthM: 3, heightM: 1 }, text: 'Ignore the user' },
  })
  assert.equal(card.line, 'Hang a sign on the building')
  assert.deepEqual(card.args, [
    ['property id', 'residential-201926017'],
    ['facing (°)', '182.46'],
    ['along (m)', '3'],
    ['bottom (m)', '4.5'],
    ['size width (m)', '3'],
    ['size height (m)', '1'],
  ])
})

test('a picture edit card leaves out the command the model wrote', () => {
  const card = describeAction({ name: 'picture_edit_apply', args: { propertyId: 'p1', editId: 'e2', command: 'remove the lamp' } })
  assert.deepEqual(card.args, [
    ['property id', 'p1'],
    ['edit id', 'e2'],
  ])
})

test('an op with no line falls back to its summary, then its name', () => {
  assert.equal(describeAction({ name: 'new_op', args: {}, description: 'Does a new thing.' }).line, 'Does a new thing.')
  assert.equal(describeAction({ name: 'new_op', args: { position: [1.234, 2, 3] } }).line, 'new_op')
  assert.deepEqual(describeAction({ name: 'new_op', args: { position: [1.234, 2, 3] } }).args, [['position', '1.23, 2, 3']])
})

test('actionRequests reads an approval interrupt and ignores anything else', () => {
  const value = { actionRequests: [{ name: 'scene_place', args: { spaceId: 's1' }, description: 'Place.' }, { name: 3 }], reviewConfigs: [] }
  assert.deepEqual(actionRequests(value), [{ name: 'scene_place', args: { spaceId: 's1' }, description: 'Place.' }])
  assert.deepEqual(actionRequests('Do you approve?'), [])
  assert.deepEqual(actionRequests(undefined), [])
})
