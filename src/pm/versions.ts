
// Version qualifiers examples:
// 1.0, 1.0.x, ~1.0.4 - patch releases only
// 1, 1.x, ^1.0.4 - minor + patch releases
// *, x - all releases

export type Qualifier = 'pinned' | 'patch' | 'minor' | 'all'

export interface VersionConstraint {
    pattern: string
    qualifier: Qualifier
    minVersion?: string
    maxVersion?: string
    label?: string
    alt?: VersionConstraint
    source?: string
}

// TODO: `synapse add expo`
// Failed to resolve dependency flow-parser@0.*

// TODO: handle `npm:`, `git:`, `http://` version specifiers
// https://docs.npmjs.com/cli/v10/configuring-npm/package-json#dependencies

// https://github.com/npm/node-semver
export function parseVersionConstraint(version: string): VersionConstraint {
    const source = version

    // if (version.startsWith('v')) {
    //     version = version.slice(1)
    // }


    if (version === '*' || version === 'x' || version === '') {
        return { pattern: 'x.x.x', qualifier: 'all', minVersion: '0.0.0', source }
    }

    if (version.includes('||')) {
        const [left, ...rest] = version.split('||').map(x => x.trim())
        const constraint = parseVersionConstraint(left)
        constraint.alt = parseVersionConstraint(rest.join(' || '))
        constraint.source = version

        return constraint
    }

    if (version.startsWith('<')) {
        const segments = version.slice(1).split('.')
        while (segments.length < 3) {
            segments.push('0')
        }
        return { pattern: `x.x.x`, qualifier: 'all', maxVersion: segments.join('.'), source }
    }

    if (version.startsWith('>=')) {
        const match = version.match(/^>=(?:[\s]*)([^\s]+) <(?:[\s]*)([^\s]+)$/)
        if (match) {
            // FIXME: this is not implemented entirely correct
            const parts = match[1].split('.')
            return { pattern: `${parts[0]}.x.x`, qualifier: 'minor', minVersion: `${parts[0]}.${parts[1] ?? 0}.${parts[2] ?? 0}`, source }
        }

        const segments = version.slice(2).split('.')
        while (segments.length < 3) {
            segments.push('0')
        }
        return { pattern: `x.x.x`, qualifier: 'all', minVersion: segments.join('.'), source }
    }

    if (version.includes(' - ')) {
        const [left, right] = version.split(' - ').map(x => x.trim())
        const leftSegments = left.split('.')
        const rightSegments = right.split('.')

        return { pattern: `x.x.x`, qualifier: 'all', minVersion: `${leftSegments[0]}.${leftSegments[1] ?? 0}.${leftSegments[2] ?? 0}`, maxVersion: `${rightSegments[0]}.${rightSegments[1] ?? 0}.${rightSegments[2] ?? 0}`}
    }

    const label = version.match(/-(.*)$/)?.[1]
    if (label) {
        version = version.replace(`-${label}`, '')
    }

    if (version.startsWith('=')) {
        return { pattern: version.slice(1), qualifier: 'pinned', label, source }
    }
    
    const segments = version.replace(/^[~^]/, '').split('.')

    if (version.startsWith('^') || segments.length === 1 || (segments.length === 2 && segments[1] === 'x')) {
        if (segments.length === 1) {
            return { pattern: `${segments[0]}.x.x`, qualifier: 'minor', minVersion: `${segments[0]}.0.0`, label, source }
        } else if (segments.length === 2) {
            return { pattern: `${segments[0]}.x.x`, qualifier: 'minor', minVersion: `${segments[0]}.${segments[1]}.0`, label, source }
        }

        if (segments[0] === '0') {
            if (segments[1] === '0') {
                return { pattern: `${segments[0]}.${segments[1]}.${segments[2]}`, qualifier: 'pinned', label, source }
            }
    
            return { pattern: `${segments[0]}.${segments[1]}.x`, qualifier: 'patch', minVersion: `${segments[0]}.${segments[1]}.${segments[2]}`, label, source }
        }

        return { pattern: `${segments[0]}.x.x`, qualifier: 'minor', minVersion: segments.join('.'), label, source }
    }

    if (version.startsWith('~') || segments.length === 2 || (segments.length === 3 && segments[2] === 'x')) {
        if (segments.length === 2) {
            return { pattern: `${segments[0]}.${segments[1]}.x`, qualifier: 'patch', minVersion: `${segments[0]}.${segments[1]}.0`, label, source }
        } else if (segments.length === 3 && !version.startsWith('~')) {
            return { pattern: `${segments[0]}.${segments[1]}.x`, qualifier: 'patch', minVersion: `${segments[0]}.${segments[1]}.0`, label, source }
        } else if (segments.length === 1) {
            return { pattern: `${segments[0]}.x.x`, qualifier: 'minor', minVersion: `${segments[0]}.0.0`, label, source }
        }

        return { pattern: `${segments[0]}.${segments[1]}.x`, qualifier: 'patch', minVersion: segments.join('.'), label, source }
    }

    return { pattern: version, qualifier: 'pinned', label, source }
}

function getQualifierSortValue(qualifier: Qualifier): number {
    switch (qualifier) {
        case 'pinned':
            return 0
        case 'patch':
            return 1
        case 'minor':
            return 2
        case 'all':
            return 3

        default:
            throw new Error(`Invalid qualifier: ${qualifier}`)
    }
}

// Must be the normalized version
export function compareVersions(a: string, b: string): number {
    const s1 = a.split('.')
    const s2 = b.split('.')

    function cmp(a: string, b: string) {
        if (a === b || a === 'x' || b === 'x') {
            return 0
        }

        return Number(a) - Number(b)
    }

    for (let i = 0; i < s1.length; i++) {
        const v = cmp(s1[i], s2[i])
        if (v !== 0) {
            return v
        }
    }

    return 0
}

function createVersionPattern(version: string) {
    return new RegExp(`^${version.replace(/\./g, '\\.').replace(/x/g, '[0-9]+')}$`)
}

function validateVersionSet(sorted: { pattern: string }[]) {
    for (let i = sorted.length - 1; i > 0; i--) {
        const { pattern: version } = sorted[i]
        if (!createVersionPattern(version).test(sorted[i - 1].pattern)) {
            throw new Error(`Incompatible versions: ${version} ∉ ${sorted[i - 1].pattern}`)
        }
    }
}

export function isExact(constraint: VersionConstraint) {
    return constraint.qualifier === 'pinned' && !constraint.alt
}

export function isCompatible(a: VersionConstraint, b: VersionConstraint, ignorePrerelease = false) {
    if (a.alt && isCompatible(a.alt, b)) {
        return true
    }
    if (b.alt && isCompatible(a, b.alt)) {
        return true
    }

    const x = compareVersions(a.pattern, b.pattern)
    if (x !== 0) {
        return false
    }

    // XXX: ignore pre-release tags that are equal to `0`
    if (!ignorePrerelease) {
        if ((a.label && a.label !== '0' && !b.label && b.source !== '*') || (!a.label && a.source !== '*' && b.label && b.label !== '0')) {
            return false
        }
    }

    if (a.qualifier === b.qualifier) {
        if (!ignorePrerelease && a.label && b.label) {
            // TODO: check comparators e.g. `1.2.3-alpha.7` should satisfy `>1.2.3-alpha.3` 
            return a.label === b.label
        }

        return true
    }

    const q = getQualifierSortValue(a.qualifier) - getQualifierSortValue(b.qualifier) 
    if (q < 0) {
        // `a` is more restrictive
        // So check if the min version of b is less than or equal to a

        return compareVersions(b.minVersion ?? b.pattern, a.maxVersion ?? a.pattern) <= 0
    }

    return compareVersions(b.maxVersion ?? b.pattern, a.minVersion ?? a.pattern) >= 0
}

// This comparison function forms contiguous segments of incompatible constraint groups
// Each constraint in a group is sorted from least restrictive to most restrictive
export function compareConstraints(a: VersionConstraint, b: VersionConstraint, useAlt = true): number {
    if (useAlt && a.alt && compareConstraints(a.alt, a, false) < 0) {
        return -compareConstraints(b, a.alt)
    }

    if (useAlt && b.alt && compareConstraints(b.alt, b, false) < 0) {
        return compareConstraints(b.alt, a)
    }

    const x = compareVersions(a.pattern, b.pattern)
    if (x !== 0) {
        return x
    }

    if (a.qualifier === b.qualifier) {
        return compareVersions(a.minVersion ?? a.pattern, b.minVersion ?? b.pattern) 
    }

    const q = getQualifierSortValue(a.qualifier) - getQualifierSortValue(b.qualifier) 
    if (q < 0) {
        // `a` is more restrictive
        // So check if the min version of b is less than or equal to a

        return compareVersions(a.pattern, b.minVersion ?? b.pattern)
    }

    return compareVersions(a.minVersion ?? a.pattern, b.pattern)
}

function sortConstraints(constraints: VersionConstraint[]) {
    return constraints.sort(compareConstraints)
}
