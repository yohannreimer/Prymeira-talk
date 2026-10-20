// Diagnostic profiles only. These never configure a deployed service.
const profiles = {
  vps: { ingress: { cpu: .5, MiB: 512 }, worker: { cpu: .75, MiB: 768 }, api: { cpu: 2, MiB: 2048 }, web: { cpu: 1, MiB: 1024 } },
  raised: { ingress: { cpu: 1, MiB: 1024 }, worker: { cpu: 2, MiB: 1536 }, api: { cpu: 2, MiB: 2048 }, web: { cpu: 2, MiB: 2048 } },
};
export function limitsFor(name) {
  if (!Object.hasOwn(profiles, name)) throw Error('Undeclared diagnostic resource profile');
  return structuredClone(profiles[name]);
}
export function resourceExperimentOrder() {
  return [ ['A','vps'], ['A','raised'], ['N','raised'], ['N','vps'], ['N','vps'], ['N','raised'], ['A','raised'], ['A','vps'] ]
    .map(([variant, resourceProfile]) => ({ profile: 'busy', variant, resourceProfile }));
}
export function twoCpuSet(allowed) {
  if (!Array.isArray(allowed) || allowed.length < 2 || allowed.some(n => !Number.isSafeInteger(n) || n < 0) || new Set(allowed).size !== allowed.length) throw Error('At least two distinct allowed CPUs required');
  return [...allowed].sort((a,b) => a-b).slice(0,2).join(',');
}
export function assertCpuSet(value) {
  if (typeof value !== 'string' || !/^\d+,\d+$/.test(value) || new Set(value.split(',')).size !== 2) throw Error('Exactly two CPU IDs required');
  return value;
}
