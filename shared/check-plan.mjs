// Free, dependency-free plan/manifest contract check.
// Usage: node shared/check-plan.mjs examples/sample-plan.json [catalog/signs.json]
// Exit 0 only when every requested sign/letter is backed by a verified catalog entry.
import { readFile } from "node:fs/promises";
import { assertPlan, assertCatalog, resolvePlan } from "./contracts.mjs";

const [planPath, catalogPath = "catalog/signs.json"] = process.argv.slice(2);
if (!planPath) {
  console.error("Usage: node shared/check-plan.mjs PLAN.json [CATALOG.json]");
  process.exit(2);
}
try {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assertPlan(plan);
  assertCatalog(catalog);
  const result = resolvePlan(plan, catalog);
  console.log(JSON.stringify(result, null, 2));
  if (!result.resolvable) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
