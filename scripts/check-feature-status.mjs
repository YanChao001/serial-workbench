import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SCOPES = new Set(["included", "excluded", "deferred"]);
const STATUSES = new Set([
  "not-started",
  "in-progress",
  "passed",
  "failed",
  "blocked",
  "not-applicable",
]);
const PHASES = ["software", "hardware", "release"];

/** @param {string} markdown @returns {string[]} */
export function readMatrixIds(markdown) {
  return [...markdown.matchAll(/^\s*\|\s*([A-Z]+-\d{2})\s*\|/gm)].map(
    (match) => match[1],
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(value, allowed, location, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      errors.push(`${location}: unexpected field ${key}`);
  }
}

function isEvidenceLink(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^\/[^/]+\/[^/]+\/(?:pull\/[1-9]\d*\/?|releases\/tag\/[^/]+\/?)$/.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

/** @param {string[]} matrixIds @param {unknown} document @returns {string[]} */
export function validateFeatureStatus(matrixIds, document) {
  const errors = [];
  const expected = new Set();
  for (const id of matrixIds) {
    if (expected.has(id)) errors.push(`matrix: duplicate ID ${id}`);
    expected.add(id);
  }
  if (!isRecord(document)) {
    errors.push("document must be an object");
    return errors;
  }
  checkKeys(document, ["schemaVersion", "features"], "document", errors);
  if (document.schemaVersion !== 1) {
    errors.push(
      "schemaVersion must be 1; unsupported schemas are not accepted",
    );
  }
  if (!Array.isArray(document.features)) {
    errors.push("features must be an array");
    return errors;
  }
  const found = new Set();
  for (const [index, feature] of document.features.entries()) {
    const location = `features[${index}]`;
    if (!isRecord(feature)) {
      errors.push(`${location} must be an object`);
      continue;
    }
    const id = feature.id;
    const label = typeof id === "string" ? id : location;
    checkKeys(feature, ["id", "scope", "scopeNote", ...PHASES], label, errors);
    if (typeof id !== "string" || !/^[A-Z]+-\d{2}$/.test(id)) {
      errors.push(`${location}.id must be a feature ID`);
    } else {
      if (found.has(id)) errors.push(`duplicate ID ${id}`);
      found.add(id);
      if (!expected.has(id)) errors.push(`extra ID ${id}`);
    }
    if (!SCOPES.has(feature.scope)) errors.push(`${label}.scope is unknown`);
    if (typeof feature.scopeNote !== "string") {
      errors.push(`${label}.scopeNote must be a string`);
    } else if (
      (feature.scope === "excluded" || feature.scope === "deferred") &&
      !feature.scopeNote.trim()
    ) {
      errors.push(`${label}.scopeNote must explain excluded/deferred scope`);
    }
    for (const phase of PHASES) {
      const stage = feature[phase];
      const stageLabel = `${label}.${phase}`;
      if (!isRecord(stage)) {
        errors.push(`${stageLabel} must be an object`);
        continue;
      }
      checkKeys(stage, ["status", "evidence"], stageLabel, errors);
      if (!STATUSES.has(stage.status))
        errors.push(`${stageLabel}.status is unknown`);
      if (
        feature.scope === "included" &&
        phase === "software" &&
        stage.status === "not-applicable"
      ) {
        errors.push(
          `${stageLabel}: included software cannot be not-applicable`,
        );
      }
      if (!Array.isArray(stage.evidence)) {
        errors.push(`${stageLabel}.evidence must be an array`);
      } else {
        for (const [evidenceIndex, evidence] of stage.evidence.entries()) {
          if (!isEvidenceLink(evidence)) {
            errors.push(
              `${stageLabel}.evidence[${evidenceIndex}] must be an HTTPS PR/Release link`,
            );
          }
        }
        if (stage.status === "passed" && stage.evidence.length === 0) {
          errors.push(`${stageLabel}: passed requires evidence`);
        }
      }
    }
  }
  for (const id of expected) {
    if (!found.has(id)) errors.push(`missing ID ${id}`);
  }
  return errors;
}

async function main() {
  try {
    const matrix = await readFile(
      new URL("../docs/requirements.md", import.meta.url),
      "utf8",
    );
    const document = JSON.parse(
      await readFile(
        new URL("../docs/feature-status.json", import.meta.url),
        "utf8",
      ),
    );
    const ids = readMatrixIds(matrix);
    const errors = validateFeatureStatus(ids, document);
    if (ids.length !== 247 || new Set(ids).size !== 247) {
      errors.push(
        `matrix must contain exactly 247 unique feature IDs; found ${ids.length} rows and ${new Set(ids).size} unique IDs`,
      );
    }
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Feature status valid: ${ids.length} unique IDs.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
