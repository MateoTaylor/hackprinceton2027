import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeAction, readInterrupt } from './approval.ts'

test('a sign card prints every argument, numbers with units', () => {
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
    ['text', 'Ignore the user'],
  ])
})

test('a picture edit card shows the tool and the command the model wrote', () => {
  const card = describeAction({ name: 'picture_edit_apply', args: { propertyId: 'p1', editId: 'e2', tool: 'remove', command: 'remove the lamp' } })
  assert.deepEqual(card.args, [
    ['property id', 'p1'],
    ['edit id', 'e2'],
    ['tool', 'remove'],
    ['command', 'remove the lamp'],
  ])
})

test('a long string is cut to 120 characters, and a flag reads yes or no', () => {
  const [[, text], [, flag]] = describeAction({ name: 'new_op', args: { text: 'a'.repeat(500), lit: true } }).args
  assert.equal(text, `${'a'.repeat(119)}…`)
  assert.equal(flag, 'yes')
})

test('an op with no line falls back to its summary, then its name', () => {
  assert.equal(describeAction({ name: 'new_op', args: {}, description: 'Does a new thing.' }).line, 'Does a new thing.')
  assert.equal(describeAction({ name: 'new_op', args: { position: [1.234, 2, 3] } }).line, 'new_op')
  assert.deepEqual(describeAction({ name: 'new_op', args: { position: [1.234, 2, 3] } }).args, [['position', '1.23, 2, 3']])
})

test('readInterrupt keeps one slot per request, and an unreadable one blocks approval', () => {
  const good = { name: 'signage_place', args: { propertyId: 'p1' }, description: 'Place.' }
  assert.deepEqual(readInterrupt({ actionRequests: [good], reviewConfigs: [] }), { requests: [good], approvable: true })
  assert.deepEqual(readInterrupt({ actionRequests: [good, { name: 3 }] }), { requests: [good, undefined], approvable: false })
  assert.deepEqual(readInterrupt('Do you approve?'), { requests: [], approvable: false })
  assert.deepEqual(readInterrupt(undefined), { requests: [], approvable: false })
})

test('arrays of objects and nulls show as compact JSON', () => {
  const card = describeAction({ name: 'new_op', args: { targets: [{ id: 'a' }, { id: 'b' }], room: null } })
  assert.deepEqual(card.args, [
    ['targets', '[{"id":"a"},{"id":"b"}]'],
    ['room', 'null'],
  ])
})
