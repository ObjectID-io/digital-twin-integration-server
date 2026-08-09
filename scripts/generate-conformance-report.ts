import { mkdir, readFile, writeFile } from "node:fs/promises";

const matrixPath = "./docs/iso-conformance-matrix.json";
const resultsPath = "./reports/conformance-results.json";
const outputPath = "./docs/ISO_CONFORMANCE_REPORT.md";
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const assertions = (results.testResults ?? []).flatMap((suite: any) => suite.assertionResults ?? []);
const testStatus = new Map<string, string>();
for (const assertion of assertions) {
  const text = [...(assertion.ancestorTitles ?? []), assertion.title ?? assertion.fullName ?? ""].join(" ");
  for (const id of text.match(/DT-\d+(?:-\d+)*-\d+/g) ?? []) testStatus.set(id, assertion.status);
}

const groups = new Map<string, any[]>();
for (const requirement of matrix.requirements) groups.set(requirement.standard, [...(groups.get(requirement.standard) ?? []), requirement]);
const statuses = ["SATISFIED", "PARTIAL", "EXTERNAL", "NOT_APPLICABLE", "NOT_VERIFIED"];
const lines = [
  "# ISO Conformance Report", "", `Generated: ${new Date().toISOString()}`, "",
  "> Technical evidence only. Passing tests does not establish ISO compliance or certification.", "",
  "| Standard | Total | Satisfied | Partial | External | N/A | Not verified | Failed tests |", "|---|---:|---:|---:|---:|---:|---:|---|",
];
for (const [standard, requirements] of groups) {
  const counts = Object.fromEntries(statuses.map((status) => [status, requirements.filter((item) => item.status === status).length]));
  const failed = requirements.flatMap((item) => item.tests).filter((id) => testStatus.get(id) !== "passed");
  lines.push(`| ${standard} | ${requirements.length} | ${counts.SATISFIED} | ${counts.PARTIAL} | ${counts.EXTERNAL} | ${counts.NOT_APPLICABLE} | ${counts.NOT_VERIFIED} | ${failed.join(", ") || "none"} |`);
}
const referenced = new Set(matrix.requirements.flatMap((item: any) => item.tests));
const unreferenced = [...testStatus.keys()].filter((id) => !referenced.has(id));
lines.push("", "## Test Evidence", "", `Conformance assertions: ${testStatus.size}`, `Passed: ${[...testStatus.values()].filter((status) => status === "passed").length}`, `Failed or missing: ${[...testStatus.values()].filter((status) => status !== "passed").length}`, `Unmapped test IDs: ${unreferenced.join(", ") || "none"}`, "", "Normative clause review remains incomplete wherever the matrix states `NOT_VERIFIED`.");
await mkdir("./docs", { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`);
console.log(`Generated ${outputPath}`);
