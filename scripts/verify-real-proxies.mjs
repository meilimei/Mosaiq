// Temp helper: verify the bound residential proxy for each real-* persona.
// Headless — just fetches ipinfo.io through each proxy. Safe to delete after.
import { loadPersona, verifyProxy } from '../packages/sdk/dist/index.js';

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['real-win11', 'real-win10', 'real-macos', 'real-ubuntu'];

for (const id of ids) {
  const persona = loadPersona(id);
  const proxy = persona.network?.proxy;
  const personaTz = persona.system?.timezone;
  if (!proxy) {
    console.log(`\n[${id}] ❌ no proxy bound`);
    continue;
  }
  process.stdout.write(`\n[${id}] verifying ${proxy.label ?? ''} ...\n`);
  const r = await verifyProxy(proxy, { timeoutMs: 25_000 });
  if (!r.ok) {
    console.log(`  ❌ FAIL: ${r.error} (${r.latencyMs}ms)`);
    continue;
  }
  const tzMatch = r.detectedTimezone === personaTz ? 'OK' : `MISMATCH (persona=${personaTz})`;
  console.log(`  ✅ exitIp=${r.exitIp}  country=${r.country}  city=${r.city ?? '-'}`);
  console.log(`     org=${r.org ?? '-'}`);
  console.log(`     proxyTz=${r.detectedTimezone ?? '-'}  vs personaTz=${personaTz} -> ${tzMatch}`);
  console.log(`     latency=${r.latencyMs}ms`);
}
