/**
 * Architecture rules from docs/codebase-structure.md, enforced mechanically.
 * Rules that live only in a document get broken by the third agent on a Friday.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment:
        'domain/ must not import frameworks, Cloudflare types, Drizzle or any ' +
        'adapter. It is pure functions and entities. (CONVE-13)',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain' },
      to: {
        path: '^(src/platform|src/modules/[^/]+/(adapters|http)|node_modules)',
      },
    },
    {
      name: 'no-deep-cross-module-imports',
      comment:
        "A module's index.ts is its entire public surface. From outside, the only " +
        'legal path is @/modules/<name>. (CONVE-12)',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/(?!$1/)[^/]+/.+' },
    },
    {
      name: 'better-auth-is-confined',
      comment:
        'better-auth is the sole layering exception and its reach is bounded to ' +
        'modules/identity and the auth middleware. (CONVE-15, codebase-structure §7)',
      severity: 'error',
      from: {
        pathNot: '^src/(modules/identity/|http/middleware/auth\\.ts)',
      },
      to: { path: 'node_modules/better-auth' },
    },
    {
      name: 'platform-only-from-adapters',
      comment:
        'domain, ports and use-cases receive ports; only adapters touch platform.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/(domain|ports|use-cases)' },
      to: { path: '^src/platform' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies signal a boundary drawn in the wrong place.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      // src/index.ts is the Worker entrypoint — nothing imports it by design.
      from: { orphan: true, pathNot: '(\\.d\\.ts$|^src/index\\.ts$)' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require'] },
  },
}
