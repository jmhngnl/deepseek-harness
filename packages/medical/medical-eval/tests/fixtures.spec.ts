/**
 * Fixture-registry coverage: the closed table a golden case resolves through.
 *
 * The registry is the reason benchmark data cannot name a file. These tests pin
 * that: an id the table does not hold is refused, a traversal or an absolute
 * path is refused for the same reason, and every entry the table claims really
 * exists on disk.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GoldenCaseError, fixtureCatalog, fixtureIds, loadImageFixture } from '../src/index.ts'

/** The directory the registry's files live in. */
const DIRECTORY = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

describe('the registry table', () => {
  it('holds the fixtures the roster names', () => {
    expect(fixtureIds()).toEqual([
      'synthetic-visible-patch',
      'synthetic-second-view',
      'synthetic-low-quality',
    ])
  })

  it('describes every entry, and every entry is a PNG', () => {
    for (const entry of fixtureCatalog()) {
      expect(entry.file).toMatch(/^[a-z0-9-]+\.png$/)
      expect(entry.mediaType).toBe('image/png')
      expect(entry.description.trim()).not.toBe('')
    }
  })

  it('accounts for every file in its directory, and for no others', () => {
    const onDisk = readdirSync(DIRECTORY).filter(entry => entry.endsWith('.png')).sort()
    expect(fixtureCatalog().map(entry => entry.file).sort()).toEqual(onDisk)
  })
})

describe('loading a fixture', () => {
  it('returns the bytes and the declared media type', () => {
    const fixture = loadImageFixture('synthetic-visible-patch')
    expect(fixture.id).toBe('synthetic-visible-patch')
    expect(fixture.mediaType).toBe('image/png')
    // A PNG signature, so the bytes really are the file the table names.
    expect([...fixture.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('reads the same bytes the file holds', () => {
    const fixture = loadImageFixture('synthetic-second-view')
    expect(Buffer.from(fixture.bytes).equals(readFileSync(`${DIRECTORY}synthetic-second-view.png`)))
      .toBe(true)
  })

  it('refuses an id the table does not hold', () => {
    expect(() => loadImageFixture('no-such-fixture')).toThrow(GoldenCaseError)
    expect(() => loadImageFixture('no-such-fixture')).toThrow(/unknown image fixture "no-such-fixture"/)
  })

  it('refuses a path, because an id is looked up rather than joined', () => {
    for (const attempt of [
      '../../../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '../images/synthetic-visible-patch.png',
      'synthetic-visible-patch.png',
    ]) {
      expect(() => loadImageFixture(attempt), attempt).toThrow(/unknown image fixture/)
    }
  })
})
