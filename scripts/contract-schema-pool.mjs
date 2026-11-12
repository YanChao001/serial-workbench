const SHARED_SCHEMA = "urn:serial-workbench:shared-contracts";
const MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);
const SINGLES = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
]);
const ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// 只遍历 schema 位置；const/default/examples 中同名字段是数据，不能改写。
function mapSchema(schema, visit) {
  if (!record(schema)) return schema;
  const next = { ...schema };
  for (const [key, value] of Object.entries(next)) {
    if (MAPS.has(key) && record(value))
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          mapSchema(child, visit),
        ]),
      );
    else if (SINGLES.has(key)) next[key] = mapSchema(value, visit);
    else if (ARRAYS.has(key) && Array.isArray(value))
      next[key] = value.map((child) => mapSchema(child, visit));
    else if (key === "items")
      next[key] = Array.isArray(value)
        ? value.map((child) => mapSchema(child, visit))
        : mapSchema(value, visit);
    else if (key === "dependencies" && record(value))
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          Array.isArray(child) ? child : mapSchema(child, visit),
        ]),
      );
  }
  return visit(next);
}

function definitionName(reference) {
  const match = /^#\/definitions\/([^/]+)(?:\/|$)/.exec(reference);
  return match?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 共用完全相同的 Rust 定义；冲突及其依赖仍保留在原 root 命名空间。 */
export function poolContractSchemas(schemas) {
  let scopedIds = false;
  for (const schema of Object.values(schemas))
    mapSchema(schema, (node) => {
      if (
        node.$id !== undefined ||
        node.id !== undefined ||
        node.$anchor !== undefined ||
        (typeof node.$ref === "string" &&
          node.$ref !== "#" &&
          !node.$ref.startsWith("#/"))
      )
        scopedIds = true;
      return node;
    });
  // URI/anchor 自带基址语义；未来导出出现此结构时保留原编译方式。
  if (scopedIds) return undefined;
  const definitions = new Map();
  const unsafe = new Set();
  const dependencies = new Map();
  for (const schema of Object.values(schemas)) {
    const local = schema.definitions ?? {};
    for (const [name, value] of Object.entries(local)) {
      const previous = definitions.get(name);
      if (
        definitions.has(name) &&
        JSON.stringify(previous) !== JSON.stringify(value)
      )
        unsafe.add(name);
      else definitions.set(name, value);
      const references = dependencies.get(name) ?? new Set();
      mapSchema(value, (node) => {
        if (
          node.$id !== undefined ||
          node.id !== undefined ||
          node.$anchor !== undefined
        )
          unsafe.add(name);
        if (typeof node.$ref === "string") {
          const dependency = definitionName(node.$ref);
          if (!dependency || !Object.hasOwn(local, dependency))
            unsafe.add(name);
          else references.add(dependency);
        }
        return node;
      });
      dependencies.set(name, references);
    }
  }
  // 同名且内容相同的 Wrapper 仍可能指向不同的局部定义；不能仅比较 Wrapper 字节。
  let changed;
  do {
    changed = false;
    for (const [name, references] of dependencies) {
      if (
        !unsafe.has(name) &&
        [...references].some((reference) => unsafe.has(reference))
      ) {
        unsafe.add(name);
        changed = true;
      }
    }
  } while (changed);
  const shared = new Set(
    [...definitions.keys()].filter((name) => !unsafe.has(name)),
  );
  const sharedPrefix = "#/definitions/shared/definitions";
  const rootPrefix = "#/definitions/roots/definitions";
  const pointer = (name) => name.replace(/~/g, "~0").replace(/\//g, "~1");
  const rewrite = (schema, available, base) =>
    mapSchema(schema, (node) => {
      const name =
        typeof node.$ref === "string" ? definitionName(node.$ref) : undefined;
      if (name && shared.has(name) && Object.hasOwn(available, name))
        return {
          ...node,
          $ref: sharedPrefix + node.$ref.slice("#/definitions".length),
        };
      if (
        typeof node.$ref === "string" &&
        (node.$ref === "#" || node.$ref.startsWith("#/"))
      )
        return { ...node, $ref: base + node.$ref.slice(1) };
      return node;
    });
  const roots = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const local = schema.definitions ?? {};
      const next = rewrite(schema, local, `${rootPrefix}/${pointer(name)}`);
      if (next.definitions) {
        const retained = Object.fromEntries(
          Object.entries(next.definitions).filter(([key]) => !shared.has(key)),
        );
        if (Object.keys(retained).length) next.definitions = retained;
        else delete next.definitions;
      }
      return [name, next];
    }),
  );
  const available = Object.fromEntries(definitions);
  return {
    // 所有入口在一个 Ajv root 下编译，引用缓存才能跨导出入口复用。
    schema: {
      $id: SHARED_SCHEMA,
      definitions: {
        roots: { definitions: roots },
        shared: {
          definitions: Object.fromEntries(
            [...shared]
              .sort()
              .map((name) => [
                name,
                rewrite(
                  definitions.get(name),
                  available,
                  `${sharedPrefix}/${pointer(name)}`,
                ),
              ]),
          ),
        },
      },
    },
    entries: Object.fromEntries(
      Object.keys(schemas).map((name) => [
        name,
        `${SHARED_SCHEMA}${rootPrefix}/${pointer(name)}`,
      ]),
    ),
  };
}
