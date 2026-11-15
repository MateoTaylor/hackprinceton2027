import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const THREE_MODULE = /^(three|three\/addons(\/.*)?|three\/examples(\/.*)?|three-mesh-bvh)$/
const STATEMENT = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g

function runtimeThreeImports(source: string) {
  return [...source.matchAll(STATEMENT)]
    .filter(([, , typeOnly, specifier, dynamic]) => THREE_MODULE.test(specifier ?? dynamic) && !typeOnly)
    .map(([statement]) => statement)
}

test('the matcher tells type imports from runtime imports', () => {
  assert.deepEqual(runtimeThreeImports(`import type * as THREE from 'three'\nexport type { Mesh } from 'three'`), [])
  assert.equal(runtimeThreeImports(`import * as THREE from 'three'`).length, 1)
  assert.equal(runtimeThreeImports(`import { type Mesh } from 'three'`).length, 1)
  assert.equal(runtimeThreeImports(`import 'three-mesh-bvh'`).length, 1)
  assert.equal(runtimeThreeImports(`import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'`).length, 1)
  assert.equal(runtimeThreeImports(`const three = await import('three')`).length, 1)
  assert.deepEqual(runtimeThreeImports(`import { useState } from 'react'`), [])
})

test('no file in the scene folder loads its own copy of three.js', () => {
  const folder = import.meta.dirname
  const offenders = readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('imports.test.ts'))
    .flatMap((file) => runtimeThreeImports(readFileSync(join(folder, file), 'utf8')).map((statement) => `${file}: ${statement}`))
  assert.deepEqual(offenders, [], 'build objects with handle.three, the viewer module')
})
