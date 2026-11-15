/**
 * Pure helpers that freeze the public export surface of the @dodash/* workspace
 * packages. The public surface of a package is the set of named exports of its
 * entry barrel (`src/index.ts`, the only entry declared in package.json).
 *
 * Both value and type exports are collected: for a TypeScript consumer, removing
 * a type export breaks compilation as surely as removing a value export.
 *
 * The collectors are pure functions over file content so they can be unit-tested
 * with inline fixtures; only the architecture test performs IO.
 */

const REEXPORT_TYPE = /export\s+type\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/gu;
const REEXPORT_VALUE = /export\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/gu;
const VALUE_DECLARATION =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/gu;
const TYPE_DECLARATION =
  /export\s+(?:declare\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu;

/** Names listed inside an `export { ... }` block (`a`, `type a`, `a as b`). */
const parseExportBlock = (block) =>
  block
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/u).pop().trim())
    .map((entry) => entry.replace(/^type\s+/u, ""));

/**
 * Collect the sorted public export names of an entry barrel source.
 * Throws on shapes that would silently escape the registry (`export *`,
 * `export default`): an unknown surface must fail loudly, not pass.
 */
export const collectPublicExports = (source) => {
  if (/export\s+\*/u.test(source)) {
    throw new Error("Unsupported public export shape: `export *` (fail closed)");
  }
  if (/export\s+default\b/u.test(source)) {
    throw new Error(
      "Unsupported public export shape: `export default` (fail closed)",
    );
  }
  const names = new Set();
  // Type re-exports are consumed first so REEXPORT_VALUE never sees their block.
  for (const [, block] of source.matchAll(REEXPORT_TYPE)) {
    for (const name of parseExportBlock(block)) names.add(name);
  }
  const withoutTypeReexports = source.replace(REEXPORT_TYPE, "");
  for (const [, block] of withoutTypeReexports.matchAll(REEXPORT_VALUE)) {
    for (const name of parseExportBlock(block)) names.add(name);
  }
  for (const [, name] of withoutTypeReexports.matchAll(VALUE_DECLARATION)) {
    names.add(name);
  }
  for (const [, name] of withoutTypeReexports.matchAll(TYPE_DECLARATION)) {
    names.add(name);
  }
  return [...names].sort();
};

/** Compare a collected surface with the registry entry for one package. */
export const diffPublicExports = (collected, registered) => {
  const collectedSet = new Set(collected);
  const registeredSet = new Set(registered);
  return {
    missing: registered.filter((name) => !collectedSet.has(name)),
    added: collected.filter((name) => !registeredSet.has(name)),
  };
};
